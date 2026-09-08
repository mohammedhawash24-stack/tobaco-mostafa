-- Run this once in Supabase SQL Editor if you see:
-- Could not find the function public.delete_customer(p_customer_id) in the schema cache
-- This installs/refreshes the customer deletion and payment deletion RPCs.

create or replace function public.delete_customer_payment(p_payment_id uuid)
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
  delete from public.customer_payments where id = p_payment_id;
  return true;
end;
$$;

grant execute on function public.delete_customer_payment(uuid) to authenticated;

create or replace function public.delete_customer(p_customer_id uuid)
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

notify pgrst, 'reload schema';

-- Product delete RPC repair
create or replace function public.delete_product(p_product_id uuid)
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
  delete from public.stock_movements where product_id = p_product_id;
  delete from public.products where id = p_product_id;
  return true;
end;
$$;

grant execute on function public.delete_product(uuid) to authenticated;

notify pgrst, 'reload schema';
