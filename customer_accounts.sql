-- Historical order item type support. Safe to run repeatedly.
alter table public.order_items add column if not exists type text;

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



-- Opening balances for amounts that existed before the app was introduced.
-- Positive amount = customer owes the shop. Negative amount = customer credit.
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
