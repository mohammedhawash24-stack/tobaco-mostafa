-- Tobacco Shop Manager: Supabase setup for the live app.
-- Preserve the product type on each historical order item so receipts/reports remain stable even if a product changes later.
alter table public.order_items add column if not exists type text;

-- Run this in Supabase SQL Editor AFTER the main database schema.
-- This file intentionally contains no Mock API, customer-debt, or payment logic.

create or replace function public.complete_order(
  p_customer_id uuid default null,
  p_customer_name text default 'Walk-in / No customer',
  p_discount numeric default 0,
  p_items jsonb default '[]'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_order_number bigint;
  v_subtotal numeric(12,2) := 0;
  v_cost numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_profit numeric(12,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_sold_price numeric(12,2);
  v_line numeric(12,2);
  v_product_id uuid;
  v_seen jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item';
  end if;

  if coalesce(p_discount, 0) < 0 then
    raise exception 'Discount cannot be negative';
  end if;

  -- First pass: validate and aggregate quantities per product.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    if v_product_id is null or v_qty is null or v_qty < 1 then
      raise exception 'Invalid order item';
    end if;
    v_seen := jsonb_set(
      v_seen,
      array[v_product_id::text],
      to_jsonb(coalesce((v_seen->>v_product_id::text)::integer, 0) + v_qty),
      true
    );
  end loop;

  -- Lock each product once and calculate totals from current purchase cost.
  for v_product_id in select key::uuid from jsonb_each(v_seen) loop
    select * into v_product
    from public.products
    where id = v_product_id
    for update;

    if not found then
      raise exception 'Product not found';
    end if;

    v_qty := (v_seen->>v_product_id::text)::integer;
    if (v_product.quantity) < v_qty then
      raise exception 'Not enough stock for %', v_product.name;
    end if;

    -- Use the first requested sold price for a product; the app normally sends one row per product.
    select coalesce((x->>'sold_price')::numeric, v_product.selling_price) into v_sold_price
    from jsonb_array_elements(p_items) x
    where (x->>'product_id')::uuid = v_product_id
    limit 1;
    v_sold_price := coalesce(v_sold_price, v_product.selling_price);

    v_subtotal := v_subtotal + (v_qty * v_sold_price);
    v_cost := v_cost + (v_qty * v_product.purchase_cost);
  end loop;

  if coalesce(p_discount, 0) > v_subtotal then
    raise exception 'Discount cannot exceed subtotal';
  end if;

  v_total := v_subtotal - coalesce(p_discount, 0);
  v_profit := v_total - v_cost;

  insert into public.orders (
    customer_id, customer_name, subtotal, discount, total, profit, status, created_by
  ) values (
    p_customer_id,
    coalesce(nullif(trim(p_customer_name), ''), 'Walk-in / No customer'),
    v_subtotal, coalesce(p_discount, 0), v_total, v_profit, 'completed', auth.uid()
  ) returning id, order_number into v_order_id, v_order_number;

  -- Insert each cart row and reduce stock atomically.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    select * into v_product from public.products where id = v_product_id for update;
    v_sold_price := coalesce((v_item->>'sold_price')::numeric, v_product.selling_price);

    insert into public.order_items (
      order_id, product_id, product_name, type, quantity, base_price, sold_price
    ) values (
      v_order_id, v_product.id, v_product.name, coalesce(nullif(trim(v_item->>'type'), ''), v_product.type, 'Other'), v_qty, v_product.purchase_cost, v_sold_price
    );

    update public.products set quantity = quantity - v_qty where id = v_product.id;

    insert into public.stock_movements (
      product_id, order_id, movement_type, quantity, purchase_cost, reason, created_by
    ) values (
      v_product.id, v_order_id, 'sale', -v_qty, v_product.purchase_cost,
      'Sale #' || v_order_number, auth.uid()
    );
  end loop;

  return v_order_number;
end;
$$;

grant execute on function public.complete_order(uuid, text, numeric, jsonb) to authenticated;

-- Delete a completed order and restore its sold quantities to inventory.
-- Admin-only and atomic. The order and its sale movements are removed.
create or replace function public.delete_order(
  p_order_number bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_item record;
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  select id into v_order_id
  from public.orders
  where order_number = p_order_number
    and status = 'completed'
  for update;

  if not found then
    raise exception 'Order #% not found', p_order_number;
  end if;

  -- Restore every product quantity from the deleted order.
  for v_item in
    select product_id, sum(quantity)::integer as quantity
    from public.order_items
    where order_id = v_order_id
    group by product_id
  loop
    update public.products
    set quantity = quantity + v_item.quantity
    where id = v_item.product_id;

    if not found then
      raise exception 'Product for order #% no longer exists', p_order_number;
    end if;
  end loop;

  delete from public.stock_movements where order_id = v_order_id;
  delete from public.order_items where order_id = v_order_id;
  delete from public.orders where id = v_order_id;

  return true;
end;
$$;

grant execute on function public.delete_order(bigint) to authenticated;


-- Delete a product safely. Admin-only. Products with sales history are protected
-- so accounting/order history can never be broken. Unsold stock movements may
-- be removed together with the product because they cannot affect order history.
create or replace function public.delete_product(
  p_product_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found';
  end if;

  if exists (select 1 from public.order_items where product_id = p_product_id) then
    raise exception 'Cannot delete a product with order history. Keep it for accounting records.';
  end if;

  -- No order history exists, so related stock movements can be removed safely.
  delete from public.stock_movements where product_id = p_product_id;
  delete from public.products where id = p_product_id;

  return true;
end;
$$;

grant execute on function public.delete_product(uuid) to authenticated;


create or replace function public.record_stock_purchase(
  p_product_id uuid,
  p_quantity integer,
  p_purchase_cost numeric default null,
  p_supplier_id uuid default null,
  p_reason text default 'Stock purchase'
)
returns public.products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_cost numeric(12,2);
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;
  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantity must be a non-zero whole number';
  end if;
  if p_quantity < 0 then
    raise exception 'Stock purchases cannot reduce stock';
  end if;
  select * into v_product from public.products where id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;
  v_cost := coalesce(p_purchase_cost, v_product.purchase_cost, 0);
  if v_cost < 0 then raise exception 'Purchase cost is invalid'; end if;
  if p_supplier_id is not null and not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'Supplier not found';
  end if;

  update public.products
    set quantity = quantity + p_quantity,
        purchase_cost = case when p_purchase_cost is not null then v_cost else purchase_cost end
    where id = p_product_id
    returning * into v_product;

  insert into public.stock_movements
    (product_id, movement_type, quantity, purchase_cost, reason, supplier_id, created_by)
  values
    (p_product_id, 'purchase', p_quantity, v_cost, coalesce(p_reason,'Stock purchase'), p_supplier_id, auth.uid());

  return v_product;
end;
$$;

grant execute on function public.record_stock_purchase(uuid, integer, numeric, uuid, text) to authenticated;

-- FAST product creation: one round-trip for product + supplier + opening stock + movement.
create or replace function public.create_product_with_stock(
  p_name text,
  p_brand text,
  p_type text,
  p_variant text,
  p_purchase_cost numeric,
  p_selling_price numeric,
  p_quantity integer,
  p_minimum_stock integer,
  p_image_url text,
  p_supplier_name text
)
returns public.products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_supplier_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;

  if nullif(trim(p_supplier_name), '') is not null then
    select id into v_supplier_id from public.suppliers
    where lower(trim(name)) = lower(trim(p_supplier_name)) limit 1;
    if v_supplier_id is null then
      insert into public.suppliers(name) values (trim(p_supplier_name)) returning id into v_supplier_id;
    end if;
  end if;

  insert into public.products(name, brand, type, variant, purchase_cost, selling_price, quantity, minimum_stock, image_url)
  values (trim(p_name), nullif(trim(p_brand), ''), trim(p_type), nullif(trim(p_variant), ''),
          p_purchase_cost, p_selling_price, greatest(coalesce(p_quantity,0),0), greatest(coalesce(p_minimum_stock,0),0), p_image_url)
  returning * into v_product;

  if coalesce(p_quantity,0) > 0 then
    insert into public.stock_movements(product_id, supplier_id, movement_type, quantity, purchase_cost, reason)
    values (v_product.id, v_supplier_id, 'purchase', p_quantity, p_purchase_cost, 'Initial stock');
  end if;

  return v_product;
end;
$$;

grant execute on function public.create_product_with_stock(text,text,text,text,numeric,numeric,integer,integer,text,text) to authenticated;



-- Customer accounts & payments
-- ============================================
-- CUSTOMER ACCOUNTS & PAYMENTS
-- ============================================

create table if not exists public.customer_payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists customer_payments_customer_id_idx
  on public.customer_payments(customer_id);

create index if not exists customer_payments_created_at_idx
  on public.customer_payments(created_at desc);

alter table public.customer_payments enable row level security;

drop policy if exists "Admins can view customer payments" on public.customer_payments;
create policy "Admins can view customer payments"
on public.customer_payments for select
using (public.is_admin());

drop policy if exists "Admins can insert customer payments" on public.customer_payments;
create policy "Admins can insert customer payments"
on public.customer_payments for insert
with check (public.is_admin());

drop policy if exists "Admins can update customer payments" on public.customer_payments;
create policy "Admins can update customer payments"
on public.customer_payments for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete customer payments" on public.customer_payments;
create policy "Admins can delete customer payments"
on public.customer_payments for delete
using (public.is_admin());

-- Record a payment against a customer's outstanding balance.
-- The check is performed inside the database so the balance cannot be raced by two payments.
create or replace function public.record_customer_payment(
  p_customer_id uuid,
  p_amount numeric,
  p_note text default null
)
returns public.customer_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.customer_payments;
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if p_customer_id is null or not exists (
    select 1 from public.customers where id = p_customer_id
  ) then
    raise exception 'Customer not found';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  insert into public.customer_payments(customer_id, amount, note, created_by)
  values (p_customer_id, round(p_amount, 2), nullif(trim(p_note), ''), auth.uid())
  returning * into v_payment;

  return v_payment;
end;
$$;

grant execute on function public.record_customer_payment(uuid,numeric,text) to authenticated;

-- Delete a payment (admin only). The account balance is recalculated from remaining payments.
create or replace function public.delete_customer_payment(
  p_payment_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if not exists (select 1 from public.customer_payments where id = p_payment_id) then
    raise exception 'Payment not found';
  end if;

  delete from public.customer_payments
  where id = p_payment_id;

  return true;
end;
$$;

grant execute on function public.delete_customer_payment(uuid) to authenticated;

-- Delete only customers with no order history and no payments.
-- Historical customer accounts must remain intact.
create or replace function public.delete_customer(
  p_customer_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'Customer not found';
  end if;

  if exists (select 1 from public.orders where customer_id = p_customer_id) then
    raise exception 'Cannot delete a customer with order history. Keep the account to preserve historical records.';
  end if;

  if exists (select 1 from public.customer_payments where customer_id = p_customer_id) then
    raise exception 'Cannot delete a customer with payment history.';
  end if;

  delete from public.customer_prices where customer_id = p_customer_id;
  delete from public.customers where id = p_customer_id;

  return true;
end;
$$;

grant execute on function public.delete_customer(uuid) to authenticated;



-- Customer opening balances. Positive = customer owes shop; negative = customer credit.
create table if not exists public.customer_opening_balances (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  amount numeric(12,2) not null default 0,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.customer_opening_balances enable row level security;
drop policy if exists "Admins can view opening balances" on public.customer_opening_balances;
create policy "Admins can view opening balances" on public.customer_opening_balances for select using (public.is_admin());
drop policy if exists "Admins can insert opening balances" on public.customer_opening_balances;
create policy "Admins can insert opening balances" on public.customer_opening_balances for insert with check (public.is_admin());
drop policy if exists "Admins can update opening balances" on public.customer_opening_balances;
create policy "Admins can update opening balances" on public.customer_opening_balances for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admins can delete opening balances" on public.customer_opening_balances;
create policy "Admins can delete opening balances" on public.customer_opening_balances for delete using (public.is_admin());

notify pgrst, 'reload schema';
