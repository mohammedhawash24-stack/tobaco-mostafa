-- Customer-specific price lists
-- Run this file ONCE in Supabase SQL Editor.

create table if not exists public.customer_prices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  price numeric(12,2) not null check (price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(customer_id, product_id)
);

create index if not exists customer_prices_customer_id_idx on public.customer_prices(customer_id);
create index if not exists customer_prices_product_id_idx on public.customer_prices(product_id);

drop trigger if exists customer_prices_set_updated_at on public.customer_prices;
create trigger customer_prices_set_updated_at
before update on public.customer_prices
for each row execute function public.set_updated_at();

alter table public.customer_prices enable row level security;
drop policy if exists "Admins can read customer prices" on public.customer_prices;
drop policy if exists "Admins can insert customer prices" on public.customer_prices;
drop policy if exists "Admins can update customer prices" on public.customer_prices;
drop policy if exists "Admins can delete customer prices" on public.customer_prices;
create policy "Admins can read customer prices" on public.customer_prices for select using (public.is_admin());
create policy "Admins can insert customer prices" on public.customer_prices for insert with check (public.is_admin());
create policy "Admins can update customer prices" on public.customer_prices for update using (public.is_admin()) with check (public.is_admin());
create policy "Admins can delete customer prices" on public.customer_prices for delete using (public.is_admin());

grant select, insert, update, delete on public.customer_prices to authenticated;

notify pgrst, 'reload schema';
