# Tobacco & Cigarette Shop Admin — v20

## v20 changes
- Full UI language selector: English / עברית / العربية.
- Language switching updates page direction automatically: English LTR, Hebrew/Arabic RTL.
- Added Arabic UI translations and localized common validation/confirmation messages.
- Language selection is saved in localStorage.
- Professional, consistent styling for all native select controls, including the language selector, customer/product/supplier selectors, with RTL-aware arrows and responsive sizing.
- Existing v19 reports date-range functionality and customer/account features preserved.

## Deployment
Upload the ZIP contents to your existing Netlify site or deploy through your existing GitHub workflow.


## v28 Delete Fix
- Product deletion now uses an admin-only `delete_product(uuid)` RPC.
- Products with order history are protected.
- Unsold products can be deleted safely with their stock-movement history.
- Schema reload is placed at the end of the SQL setup files.
