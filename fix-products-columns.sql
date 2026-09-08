-- Run this ONLY if your public.products table uses the canonical columns below.
-- This file is for the Tobacco Shop app version that uses: purchase_cost, selling_price, quantity, minimum_stock.
-- If those columns already exist, this does nothing.

-- No destructive changes are performed.

-- Verify columns with:
-- select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'products' order by ordinal_position;
