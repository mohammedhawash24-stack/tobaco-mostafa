/*
 * Supabase data layer.
 * Supabase data layer for the live application.
 */
const API = (() => {
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function mapProduct(row) {
    if (!row) return row;
    return {
      id: row.id,
      name: row.name || '',
      brand: row.brand || '',
      type: row.type || '',
      variant: row.variant || '',
      supplier: row.supplier_name || '',
      supplierId: row.supplier_id || '',
      buy: Number(row.purchase_cost ?? row.buy ?? 0),
      sell: Number(row.selling_price ?? row.sell ?? 0),
      qty: Number(row.quantity ?? row.qty ?? 0),
      min: Number(row.minimum_stock ?? row.min_qty ?? row.min ?? 0),
      image: row.image_url || ''
    };
  }

  function mapCustomer(row) {
    return row ? {
      id: row.id,
      name: row.name || '',
      phone: row.phone || '',
      notes: row.notes || '',
      createdAt: row.created_at
    } : row;
  }

  function mapMovement(row) {
    return row ? {
      id: row.id,
      date: row.created_at,
      productId: row.product_id,
      productName: row.product_name || '',
      change: Number(row.quantity || 0),
      reason: row.reason || row.movement_type || ''
    } : row;
  }

  function mapOrder(row) {
    if (!row) return null;
    const items = (row.order_items || []).map((item) => ({
      id: item.id,
      productId: item.product_id,
      name: item.product_name || '',
      qty: Number(item.quantity || 0),
      buy: Number(item.base_price || 0),
      sell: Number(item.sold_price || 0),
      type: item.type || ''
    }));
    return {
      id: String(row.order_number),
      date: row.created_at,
      customerId: row.customer_id || '',
      customerName: row.customer_name || 'Walk-in / No customer',
      items,
      sub: Number(row.subtotal || 0),
      discount: Number(row.discount || 0),
      total: Number(row.total || 0),
      cost: items.reduce((sum, item) => sum + item.qty * item.buy, 0),
      profit: Number(row.profit || 0)
    };
  }

  async function get(resource) {
    if (resource === 'products') {
      const { data, error } = await window.supabaseClient.from('products').select('*').order('name');
      if (error) throw error;
      // Suppliers are stored on stock movements, not on products.
      // Keep products compatible with the existing database schema.
      return (data || []).map(row => mapProduct(row));
    }
    if (resource === 'orders') {
      // Fetch orders and their items in one PostgREST request through the FK.
      const { data, error } = await window.supabaseClient
        .from('orders')
        .select('*, order_items(*)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map((order) => mapOrder(order));
    }
    if (resource === 'stockMovements') {
      const { data, error } = await window.supabaseClient
        .from('stock_movements')
        .select('*, products(name)')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data || []).map(row => ({
        ...mapMovement(row),
        productName: row.products?.name || row.product_name || ''
      }));
    }
    if (resource === 'customers') {
      const { data, error } = await window.supabaseClient.from('customers').select('*').order('name');
      if (error) throw error;
      return data.map(mapCustomer);
    }
    if (resource === 'suppliers') {
      const { data, error } = await window.supabaseClient.from('suppliers').select('*').order('name');
      if (error) throw error;
      return data;
    }
    if (resource === 'lastReceipt') {
      const { data: order, error: orderError } = await window.supabaseClient
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) return null;
      const { data: items, error: itemsError } = await window.supabaseClient
        .from('order_items')
        .select('*')
        .eq('order_id', order.id);
      if (itemsError) throw itemsError;
      return mapOrder({ ...order, order_items: items || [] });
    }
    return null;
  }

  async function getCustomerPayments() {
    const { data, error } = await window.supabaseClient
      .from('customer_payments')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function recordCustomerPayment(customerId, amount, note = '') {
    const { data, error } = await window.supabaseClient.rpc('record_customer_payment', {
      p_customer_id: customerId,
      p_amount: Number(amount),
      p_note: note || null
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function deleteCustomerPayment(paymentId) {
    const { data, error } = await window.supabaseClient.rpc('delete_customer_payment', {
      p_payment_id: paymentId
    });

    // Some Supabase projects can have the RPC missing from PostgREST's
    // schema cache even though the SQL file contains the function.
    // Admin RLS already allows deleting payments directly, so use a safe
    // fallback only for that specific missing-function error.
    if (error) {
      const message = String(error.message || '').toLowerCase();
      const missingRpc =
        message.includes('could not find the function') &&
        message.includes('delete_customer_payment');

      if (!missingRpc) throw error;

      const { error: deleteError } = await window.supabaseClient
        .from('customer_payments')
        .delete()
        .eq('id', paymentId);

      if (deleteError) throw deleteError;
      return true;
    }

    return Boolean(data);
  }

  async function deleteCustomer(customerId) {
    const { data, error } = await window.supabaseClient.rpc('delete_customer', {
      p_customer_id: customerId
    });
    if (error) throw error;
    return Boolean(data);
  }


  async function getCustomerOpeningBalances() {
    const { data, error } = await window.supabaseClient
      .from('customer_opening_balances')
      .select('*');
    if (error) throw error;
    return data || [];
  }

  async function saveCustomerOpeningBalance(customerId, amount, note = '') {
    const { data, error } = await window.supabaseClient
      .from('customer_opening_balances')
      .upsert({
        customer_id: customerId,
        amount: Number(amount),
        note: note || null,
        updated_by: (await window.supabaseClient.auth.getUser()).data.user?.id || null
      }, { onConflict: 'customer_id' })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async function deleteCustomerOpeningBalance(customerId) {
    const { error } = await window.supabaseClient
      .from('customer_opening_balances')
      .delete()
      .eq('customer_id', customerId);
    if (error) throw error;
    return true;
  }

  async function getCustomerPrices(customerId) {
    if (!customerId) return {};
    const { data, error } = await window.supabaseClient
      .from('customer_prices')
      .select('product_id,price')
      .eq('customer_id', customerId);
    if (error) throw error;
    return Object.fromEntries((data || []).map(row => [String(row.product_id), Number(row.price)]));
  }

  async function upsertCustomerPrice(customerId, productId, price) {
    const { data, error } = await window.supabaseClient
      .from('customer_prices')
      .upsert({ customer_id: customerId, product_id: productId, price: Number(price) }, { onConflict: 'customer_id,product_id' })
      .select('product_id,price')
      .single();
    if (error) throw error;
    return data;
  }

  async function deleteCustomerPrice(customerId, productId) {
    const { error } = await window.supabaseClient
      .from('customer_prices')
      .delete()
      .eq('customer_id', customerId)
      .eq('product_id', productId);
    if (error) throw error;
  }

  async function saveCustomerPrices(customerId, rows) {
    const client = window.supabaseClient;
    const { data: current, error: currentError } = await client
      .from('customer_prices').select('product_id').eq('customer_id', customerId);
    if (currentError) throw currentError;
    const nextRows = (rows || []).map(row => ({
      customer_id: customerId, product_id: row.productId, price: Number(row.price)
    }));
    if (nextRows.length) {
      const { error } = await client.from('customer_prices')
        .upsert(nextRows, { onConflict: 'customer_id,product_id' });
      if (error) throw error;
    }
    const keep = new Set(nextRows.map(row => String(row.product_id)));
    const removed = (current || []).map(row => String(row.product_id)).filter(id => !keep.has(id));
    if (removed.length) {
      const { error } = await client.from('customer_prices')
        .delete().eq('customer_id', customerId).in('product_id', removed);
      if (error) throw error;
    }
    return Object.fromEntries(nextRows.map(row => [String(row.product_id), Number(row.price)]));
  }

  async function resolveSupplierId(name) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const { data: existing, error: findError } = await window.supabaseClient
      .from('suppliers').select('id,name').ilike('name', clean).limit(1);
    if (findError) throw findError;
    if (existing?.[0]?.id) return existing[0].id;

    const { data: created, error: createError } = await window.supabaseClient
      .from('suppliers').insert({ name: clean }).select('id').single();
    if (createError) throw createError;
    return created.id;
  }

  async function createProductFast(body) {
    const payload = {
      name: String(body.name || '').trim(),
      brand: String(body.brand || '').trim() || null,
      type: String(body.type || '').trim(),
      variant: String(body.variant || '').trim() || null,
      purchase_cost: Number(body.buy || 0),
      selling_price: Number(body.sell || 0),
      quantity: Number(body.qty || 0),
      minimum_stock: Number(body.min || 0),
      image_url: body.image || null,
      supplier_name: String(body.supplier || '').trim() || null
    };
    // Preferred: one RPC for product + supplier + opening stock + movement.
    const { data, error } = await window.supabaseClient.rpc('create_product_with_stock', {
      p_name: payload.name,
      p_brand: payload.brand,
      p_type: payload.type,
      p_variant: payload.variant,
      p_purchase_cost: payload.purchase_cost,
      p_selling_price: payload.selling_price,
      p_quantity: payload.quantity,
      p_minimum_stock: payload.minimum_stock,
      p_image_url: payload.image_url,
      p_supplier_name: payload.supplier_name
    });
    if (!error && data) return mapProduct(Array.isArray(data) ? data[0] : data);

    // Fallback for databases that have not run the latest SQL yet.
    const created = await post('products', { ...body, qty: payload.quantity });
    if (payload.supplier_name) {
      const supplierId = await resolveSupplierId(payload.supplier_name);
      if (payload.quantity > 0) await patchProductStock(created.id, payload.quantity, 'Initial stock', payload.purchase_cost, supplierId);
    }
    return created;
  }

  async function post(resource, body) {
    if (resource === 'products') {
      const payload = {
        name: String(body.name || '').trim(),
        brand: String(body.brand || '').trim() || null,
        type: String(body.type || '').trim(),
        variant: String(body.variant || '').trim() || null,
        purchase_cost: Number(body.buy || 0),
        selling_price: Number(body.sell || 0),
        quantity: Number(body.qty || 0),
        minimum_stock: Number(body.min || 0),
        image_url: body.image || null
      };
      if (!payload.name || !payload.type) throw new Error('Product name and type are required.');
      const { data, error } = await window.supabaseClient
        .from('products').insert(payload).select().single();
      if (error) throw error;
      return mapProduct(data);
    }
    if (resource === 'customers') {
      const { data, error } = await window.supabaseClient.from('customers').insert({
        name: body.name,
        phone: body.phone || null,
        notes: body.notes || null
      }).select().single();
      if (error) throw error;
      return mapCustomer(data);
    }
    throw new Error(`Unsupported create operation: ${resource}`);
  }

  async function put(resource, id, body) {
    if (resource !== 'products') throw new Error(`Unsupported update operation: ${resource}`);
    const payload = {
      name: body.name,
      brand: body.brand || null,
      type: body.type,
      variant: body.variant || null,
      purchase_cost: Number(body.buy || 0),
      selling_price: Number(body.sell || 0),
      quantity: Number(body.qty || 0),
      minimum_stock: Number(body.min || 0),
      image_url: body.image || null
    };
    const { data, error } = await window.supabaseClient.from('products').update(payload).eq('id', id).select().single();
    if (error) throw error;
    return mapProduct(data);
  }

  async function remove(resource, id) {
    if (resource !== 'products') throw new Error(`Unsupported delete operation: ${resource}`);

    // Use the admin RPC so product deletion works even when the table's direct
    // DELETE policy is missing, while preserving products that have sales history.
    const rpc = await window.supabaseClient.rpc('delete_product', {
      p_product_id: id
    });
    if (!rpc.error) return Boolean(rpc.data);

    // Fallback for projects where the RPC is not yet visible in PostgREST.
    // RLS still enforces admin-only access on the direct delete.
    const direct = await window.supabaseClient
      .from('products')
      .delete()
      .eq('id', id)
      .select('id');
    if (direct.error) {
      const rpcMessage = rpc.error?.message || 'Unknown RPC error';
      throw new Error(`${rpcMessage} | Direct delete also failed: ${direct.error.message}`);
    }
    if (!direct.data?.length) {
      throw new Error('Product was not deleted. It may have sales history or database permissions/RPC are not configured.');
    }
    return true;
  }

  async function patchProductStock(id, quantity, reason = 'Manual adjustment', purchaseCost = null, supplierId = null) {
    const qtyChange = Number(quantity || 0);
    if (!Number.isInteger(qtyChange) || qtyChange === 0) throw new Error('Quantity must be a non-zero whole number.');
    const cost = purchaseCost == null || purchaseCost === '' ? null : Number(purchaseCost);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error('Purchase cost is invalid.');

    // Preferred path: the database RPC updates stock + movement atomically.
    const rpc = await window.supabaseClient.rpc('record_stock_purchase', {
      p_product_id: id,
      p_quantity: qtyChange,
      p_purchase_cost: cost,
      p_supplier_id: supplierId || null,
      p_reason: reason || 'Manual adjustment'
    });
    if (!rpc.error) return mapProduct(rpc.data);

    // Compatibility fallback for projects where the helper SQL was not run yet.
    console.warn('record_stock_purchase RPC failed; using direct admin update:', rpc.error);
    const { data: current, error: readError } = await window.supabaseClient
      .from('products').select('*').eq('id', id).single();
    if (readError) throw readError;
    const nextQty = Number(current.quantity ?? current.qty ?? 0) + qtyChange;
    const updatePayload = { quantity: nextQty };
    if (cost !== null) updatePayload.purchase_cost = cost;
    const { data: updated, error: updateError } = await window.supabaseClient
      .from('products').update(updatePayload).eq('id', id).select().single();
    if (updateError) throw updateError;

    const { error: movementError } = await window.supabaseClient.from('stock_movements').insert({
      product_id: id,
      movement_type: 'purchase',
      quantity: qtyChange,
      purchase_cost: cost ?? Number(current.purchase_cost ?? current.buy ?? 0),
      reason: reason || 'Manual adjustment',
      supplier_id: supplierId || null
    });
    if (movementError) {
      // Do not hide a movement failure: stock was updated, but the audit record needs attention.
      throw new Error(`Stock was updated, but movement history failed: ${movementError.message}`);
    }
    return mapProduct(updated);
  }

  async function getSuppliersForStock() {
    const { data, error } = await window.supabaseClient.from('suppliers').select('id,name').order('name');
    if (error) throw error;
    return data || [];
  }

  // Products do NOT contain supplier_id in the current database schema.
  // Suppliers are attached to stock_movements instead.
  async function getOrCreateSupplierId(name, cachedSuppliers = []) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const cached = (cachedSuppliers || []).find(s => String(s.name || '').trim().toLowerCase() === clean.toLowerCase());
    if (cached?.id) return cached.id;
    return resolveSupplierId(clean);
  }

  async function getOrder(orderNumber) {
    const { data, error } = await window.supabaseClient
      .from('orders')
      .select('*, order_items(*)')
      .eq('order_number', orderNumber)
      .single();
    if (error) throw error;
    return mapOrder(data);
  }

  async function deleteOrder(orderNumber) {
    const { data, error } = await window.supabaseClient.rpc('delete_order', {
      p_order_number: Number(orderNumber)
    });
    if (error) throw error;
    return Boolean(data);
  }

  async function completeOrder(order) {
    const items = order.items.map((item) => ({
      product_id: item.productId,
      qty: Number(item.qty),
      sold_price: Number(item.sell),
      type: item.type || 'Other'
    }));

    const { data: orderNumber, error } = await window.supabaseClient.rpc('complete_order', {
      p_customer_id: order.customerId || null,
      p_customer_name: order.customerName || 'Walk-in / No customer',
      p_discount: Number(order.discount || 0),
      p_items: items
    });
    if (error) throw error;
    return String(orderNumber);
  }

  async function seedDemo() {
    const existing = await get('products');
    if (existing.length) return false;
    const rows = [
      { name: 'Marlboro Red', brand: 'Marlboro', type: 'Cigarettes', buy: 8.5, sell: 12, qty: 50, min: 10 },
      { name: 'Marlboro Gold', brand: 'Marlboro', type: 'Cigarettes', buy: 8.5, sell: 12, qty: 32, min: 8 },
      { name: 'Winston Blue', brand: 'Winston', type: 'Cigarettes', buy: 7.5, sell: 11, qty: 28, min: 7 },
      { name: 'L&M Red', brand: 'L&M', type: 'Cigarettes', buy: 7, sell: 10, qty: 40, min: 10 },
      { name: 'Camel Yellow', brand: 'Camel', type: 'Cigarettes', buy: 7.5, sell: 11, qty: 25, min: 8 },
      { name: 'Davidoff Gold', brand: 'Davidoff', type: 'Cigarettes', buy: 9, sell: 13, qty: 18, min: 6 },
      { name: 'Nargileh Apple', brand: 'Nargileh', type: 'Hookah / Argileh', buy: 16, sell: 25, qty: 5, min: 8 }
    ];
    for (const row of rows) {
      const created = await post('products', { ...row, qty: 0 });
      if (row.qty) await patchProductStock(created.id, row.qty, 'Initial demo stock');
    }
    return true;
  }

  async function reset() {
    throw new Error('Reset is disabled for the live Supabase database.');
  }

  async function login(email, password) {
    const client = window.supabaseClient;
    if (!client || !client.auth || typeof client.auth.signInWithPassword !== 'function') {
      throw new Error('Supabase is not connected. Refresh the page and make sure you are online.');
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return false;
    const { data: profile, error: profileError } = await window.supabaseClient
      .from('profiles').select('role').eq('id', data.user.id).single();
    if (profileError || profile?.role !== 'admin') {
      await window.supabaseClient.auth.signOut();
      return false;
    }
    return true;
  }

  async function logout() {
    await window.supabaseClient.auth.signOut();
  }

  return {
    get, post, put, delete: remove, patchProductStock, getOrCreateSupplierId, createProductFast,
    completeOrder, deleteOrder, getOrder, seedDemo, reset, login, logout, getCustomerPrices, upsertCustomerPrice, deleteCustomerPrice, saveCustomerPrices, getCustomerPayments, recordCustomerPayment, deleteCustomerPayment, deleteCustomer, getCustomerOpeningBalances, saveCustomerOpeningBalance, deleteCustomerOpeningBalance,
    setLastReceipt: async (receipt) => receipt
  };
})();

function hasDuplicateProduct(data, candidate, currentId = '') {
  const name = String(candidate.name || '').trim().toLowerCase();
  const brand = String(candidate.brand || '').trim().toLowerCase();
  const type = String(candidate.type || '').trim().toLowerCase();
  const variant = String(candidate.variant || '').trim().toLowerCase();
  return data.products.some((product) =>
    String(product.id) !== String(currentId) &&
    String(product.name || '').trim().toLowerCase() === name &&
    String(product.brand || '').trim().toLowerCase() === brand &&
    String(product.type || '').trim().toLowerCase() === type &&
    String(product.variant || '').trim().toLowerCase() === variant
  );
}
