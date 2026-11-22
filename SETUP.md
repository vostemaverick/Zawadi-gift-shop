# Shared product catalog setup

The storefront uses Supabase for its shared product catalog and owner sign-in. Product changes are stored online and are visible to customers. The page currently contains example products; they are replaced by the shared catalog once setup is complete.

## 1. Create the Supabase project

1. Create a Supabase project at [supabase.com](https://supabase.com/).
2. In **SQL Editor**, run the contents of [`supabase-setup.sql`](./supabase-setup.sql). This creates the product and order tables, publishes the example catalog, and enables row-level security. If you already set up the catalog, run the updated SQL again to add direct ordering.
3. In **Authentication → Providers / Sign In**, turn off **Allow new users to sign up**. In **Authentication → Users**, create the owner's account using the owner's email and a strong password. The owner must be an Auth user; adding the email to a table such as `public.users` does not grant owner access.
4. In **SQL Editor**, replace `owner@example.com` below with the exact email shown for that Auth user and run:

   ```sql
   update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"owner"}'::jsonb
   where lower(email) = lower('owner@example.com')
   returning id, email, raw_app_meta_data;
   ```

   Confirm one row is returned and `raw_app_meta_data` contains `"role": "owner"`. If no row is returned, create the user under **Authentication → Users** or check that the email matches exactly. Then sign out of the app and sign in again so Supabase issues a token with the new role. The role must be in protected app metadata; the browser cannot grant itself access.
   If sign-in reports that the email or password is incorrect, confirm this Auth user is in the same Supabase project configured in `index.html` and enter the exact Auth email. Use **Forgot password?** in the app to reset that account's password.
5. In **Project Settings → API**, copy the Project URL and the **anon/public** key. Never put the `service_role` key in the website.

## 2. Connect the storefront

The storefront already has a Supabase URL and anon/public key configured. If connecting a different Supabase project, update these constants near the start of the script in [`index.html`](./index.html):

```js
const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_PUBLIC_ANON_KEY';
```

The anon key is intended to be public. Database row-level security—not secrecy of this key—protects product editing and customer order details. Checkout uses the `place_order` database function to validate current product prices and save the order.

## 3. Manage products

Open the deployed storefront, choose **Owner**, and sign in with the owner's email and password. From the dashboard the owner can change their password, manage products, and view incoming orders. If the owner forgets the password, use **Forgot password?** on the sign-in form and follow the email link to set a new one. Customers see published items from the shared catalog.

Serve the page over HTTPS, set Supabase **Authentication → URL Configuration → Site URL** to the deployed storefront, and add that URL to **Redirect URLs**. Also allow `http://127.0.0.1:8000/**` for local browser testing. Browser reset requests return to the current storefront URL; Android app reset requests use the Site URL so the email link opens a reachable page. Do not allow public sign-ups or expose a service-role key.

## 4. Run the Android app

Install Node.js and Android Studio with its Android SDK. To preview the storefront in a browser, run `npm start` and open `http://127.0.0.1:8000`.

To launch the Android project, run from the project directory:

```sh
npm install
npm run cap:sync
npm run android
```

In Android Studio, select an emulator or connected Android device and press **Run**. `cap:sync` copies the storefront files into the Capacitor web directory before syncing the Android project.

## 5. Receive orders

Customers can search and filter the catalog, manage a cart, and place orders directly in the app. Orders are saved in Supabase; the owner can sign in and view them under **Incoming orders**. The app does not process M-Pesa or card payments, so contact the customer to confirm payment and delivery.

## 6. Push notifications for order updates

Customers can opt in to push notifications on their device to receive order status updates (`pending`, `confirmed`, `completed`, `cancelled`):

1. **Database support**: Re-run [`supabase-setup.sql`](./supabase-setup.sql) in the Supabase **SQL Editor** so the owner can update order statuses (`orders` update policy), devices can register push subscriptions (`push_subscriptions`, `register_push_subscription`, `get_order_status`), and customers can look up past orders by phone (`get_order_history_by_phone`).
2. **Web Push (Browser & PWA)**: The Node server reads `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` from environment variables (see `.env.example`). Generate a VAPID keypair with `npx web-push generate-vapid-keys` and set those variables before deploying so browser push subscriptions persist across server restarts.
3. **Android (Capacitor)**: The storefront also integrates `@capacitor/push-notifications`. To enable native Android push delivery via Firebase Cloud Messaging (FCM), add your Firebase `google-services.json` file to `android/app/google-services.json` and run `npm run cap:sync`.
