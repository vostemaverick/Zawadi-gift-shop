create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  category text not null check (category in ('mugs', 'flowers', 'hampers', 'cards')),
  price integer not null check (price > 0),
  original_price integer check (original_price is null or original_price > 0),
  rating numeric(2, 1) check (rating is null or rating between 0 and 5),
  badge text check (badge is null or char_length(badge) <= 30),
  image text not null check (char_length(image) <= 1000),
  description text not null check (char_length(description) between 1 and 300),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;

drop policy if exists "Anyone can read published products" on public.products;
create policy "Anyone can read published products"
  on public.products for select
  to anon
  using (is_published);

drop policy if exists "Customers and owner can read products" on public.products;
create policy "Customers and owner can read products"
  on public.products for select
  to authenticated
  using (
    is_published
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
  );

drop policy if exists "Owner can add products" on public.products;
create policy "Owner can add products"
  on public.products for insert
  to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

drop policy if exists "Owner can update products" on public.products;
create policy "Owner can update products"
  on public.products for update
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

drop policy if exists "Owner can delete products" on public.products;
create policy "Owner can delete products"
  on public.products for delete
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

create or replace function public.set_product_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at
  before update on public.products
  for each row execute function public.set_product_updated_at();

insert into public.products
  (id, name, category, price, original_price, rating, badge, image, description)
values
  ('00000000-0000-4000-8000-000000000001', 'Floral Ceramic Mug', 'mugs', 1200, 1500, 4.8, 'Popular', 'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?auto=format&fit=crop&w=800&q=80', 'Handcrafted ceramic mug with floral detailing.'),
  ('00000000-0000-4000-8000-000000000002', 'Pink Rose Hamper', 'hampers', 2500, 3100, 5.0, 'Best seller', 'https://images.unsplash.com/photo-1512436991641-6745cdb1723f?auto=format&fit=crop&w=800&q=80', 'A luxurious pink rose arrangement with sweet treats.'),
  ('00000000-0000-4000-8000-000000000003', 'Luxury Gift Box', 'hampers', 3200, 3900, 4.9, 'Premium', 'https://images.unsplash.com/photo-1527515637462-cff94eecc1ac?auto=format&fit=crop&w=800&q=80', 'Curated gift box packed with premium goodies.'),
  ('00000000-0000-4000-8000-000000000004', 'Romantic Rose Bouquet', 'flowers', 1800, 2200, 4.8, 'Fresh', 'https://images.unsplash.com/photo-1525310072745-f49212b5ac6d?auto=format&fit=crop&w=800&q=80', 'Freshly arranged roses for a romantic gesture.'),
  ('00000000-0000-4000-8000-000000000005', 'Mini Celebration Basket', 'hampers', 2100, 2600, 4.7, 'New', 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=800&q=80', 'Perfect for birthdays, thank-yous and milestones.'),
  ('00000000-0000-4000-8000-000000000006', 'Love Notes Card Set', 'cards', 600, 900, 4.9, 'Cute', 'https://images.unsplash.com/photo-1517849845537-4d257902454a?auto=format&fit=crop&w=800&q=80', 'Beautiful note cards with elegant design details.'),
  ('00000000-0000-4000-8000-000000000007', 'Sunflower Bouquet', 'flowers', 1500, 1900, 4.6, 'Trending', 'https://images.unsplash.com/photo-1468327768560-75b778cbb551?auto=format&fit=crop&w=800&q=80', 'Bright and cheerful bouquet for joyful moments.'),
  ('00000000-0000-4000-8000-000000000008', 'Personalized Coffee Mug', 'mugs', 1350, 1650, 4.8, 'Custom', 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80', 'A custom mug for birthdays, anniversaries or thank yous.')
on conflict (id) do nothing;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null check (char_length(btrim(customer_name)) between 1 and 100),
  customer_phone text not null check (char_length(btrim(customer_phone)) between 7 and 30),
  delivery_location text not null check (char_length(btrim(delivery_location)) between 1 and 200),
  customer_note text check (customer_note is null or char_length(customer_note) <= 1000),
  total integer not null check (total > 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price integer not null check (unit_price > 0)
);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

grant select on public.orders, public.order_items to authenticated;

drop policy if exists "Owner can read orders" on public.orders;
create policy "Owner can read orders"
  on public.orders for select
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

drop policy if exists "Owner can read order items" on public.order_items;
create policy "Owner can read order items"
  on public.order_items for select
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

create or replace function public.place_order(
  p_customer_name text,
  p_customer_phone text,
  p_delivery_location text,
  p_customer_note text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_saved_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_product record;
  v_quantity integer;
  v_total bigint := 0;
begin
  if char_length(btrim(coalesce(p_customer_name, ''))) not between 1 and 100
    or char_length(btrim(coalesce(p_customer_phone, ''))) not between 7 and 30
    or char_length(btrim(coalesce(p_delivery_location, ''))) not between 1 and 200
    or char_length(coalesce(p_customer_note, '')) > 1000 then
    raise exception 'Enter a valid name, phone number, delivery location and note.';
  end if;

  if p_items is null
    or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) < 1 then
    raise exception 'Your cart must contain at least one product.';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or jsonb_typeof(v_item -> 'id') is distinct from 'string'
      or jsonb_typeof(v_item -> 'quantity') is distinct from 'number'
      or coalesce((v_item ->> 'quantity') !~ '^[1-9][0-9]*$', true) then
      raise exception 'Your cart contains an invalid product or quantity.';
    end if;

    v_product_id := (v_item ->> 'id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    select id, name, price into v_product
    from public.products
    where id = v_product_id and is_published
    for share;

    if not found then
      raise exception 'A product in your cart is no longer available. Refresh the shop and try again.';
    end if;

    v_total := v_total + (v_product.price::bigint * v_quantity);
    if v_total > 2147483647 then
      raise exception 'The order total is too large.';
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'quantity', v_quantity,
      'unit_price', v_product.price
    ));
  end loop;

  insert into public.orders (customer_name, customer_phone, delivery_location, customer_note, total)
  values (btrim(p_customer_name), btrim(p_customer_phone), btrim(p_delivery_location), nullif(btrim(p_customer_note), ''), v_total::integer)
  returning id into v_order_id;

  for v_saved_item in select value from jsonb_array_elements(v_items)
  loop
    insert into public.order_items (order_id, product_id, product_name, quantity, unit_price)
    values (
      v_order_id,
      (v_saved_item ->> 'product_id')::uuid,
      v_saved_item ->> 'product_name',
      (v_saved_item ->> 'quantity')::integer,
      (v_saved_item ->> 'unit_price')::integer
    );
  end loop;

  return v_order_id;
end;
$$;

revoke all on function public.place_order(text, text, text, text, jsonb) from public;
grant execute on function public.place_order(text, text, text, text, jsonb) to anon, authenticated;
