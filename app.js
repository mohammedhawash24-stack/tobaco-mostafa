/*
 * Cigarette Shop Admin
 * Main application logic.
 */

const AUTH_KEY = 'cig_admin_auth';

let db = {
  products: [],
  orders: [],
  stockMovements: [],
  lastReceipt: null,
  suppliers: [],
  customers: [],
  customerPayments: [],
  customerOpeningBalances: [],
  customerOpeningBalancesLoaded: false,
};

let cart = [];

const $ = (id) => document.getElementById(id);

const money = (value) => `₪${Number(value || 0).toFixed(2)}`;

const escapeHtml = (value) => String(value ?? '').replace(
  /[&<>"']/g,
  (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character]),
);

const pages = {
  dashboard: ['לוח בקרה', 'לוח בקרה'],
  inventory: ['מלאי / מחסן', 'מלאי'],
  orders: ['הזמנה חדשה', 'הזמנה חדשה'],
  history: ['היסטוריית הזמנות', 'היסטוריית הזמנות'],
  customers: ['לקוחות', 'לקוחות'],
  reports: ['דוחות', 'דוחות'],
  movements: ['תנועות מלאי', 'תנועות מלאי'],
  receipt: ['קבלה', 'קבלה'],
};

async function refresh(options = {}) {
  // Fast startup: load only the data needed by the current screen.
  // Orders/movements are loaded lazily when their pages are opened.
  const [products, suppliers, customers] = await Promise.all([
    API.get('products'),
    API.get('suppliers').catch(() => []),
    API.get('customers').catch(() => []),
  ]);
  db.products = products || [];
  db.suppliers = suppliers || [];
  db.customers = customers || [];
  if (window.renderOrderCustomers) window.renderOrderCustomers(db.customers);

  if (options.withOrders) {
    const [orders, stockMovements] = await Promise.all([
      API.get('orders'),
      API.get('stockMovements'),
    ]);
    db.orders = orders || [];
    db.stockMovements = stockMovements || [];
    db.lastReceipt = db.orders[0] || null;
  }
  render();
}

async function login() {
  const email = $('user').value.trim();
  const password = $('pass').value;
  if (!email || !password) {
    $('loginMsg').textContent = 'Enter your email and password.';
    return;
  }
  try {
    const client = window.supabaseClient;
    if (!client?.auth || typeof client.auth.signInWithPassword !== 'function') {
      throw new Error('Supabase is not connected. Check your internet connection and refresh the page.');
    }

    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    if (!data?.user) throw new Error('Login failed: no user was returned.');

    const { data: profile, error: profileError } = await client
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .single();

    if (profileError) throw profileError;
    if (profile?.role !== 'admin') {
      await client.auth.signOut();
      throw new Error('Admin access required.');
    }

    sessionStorage.setItem(AUTH_KEY, '1');
    await showApp();
  } catch (error) {
    console.error('Login failed:', error);
    $('loginMsg').textContent = error?.message || 'Login failed.';
  }
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('todayDate').textContent = new Date().toLocaleDateString();
  try {
    await refresh();
    // Load historical orders in the background so Total Profit is cumulative
    // without slowing down the initial login screen.
    API.get('orders').then((orders) => {
      db.orders = orders || [];
      db.lastReceipt = db.orders[0] || null;
      renderStats();
      renderDashboard();
    }).catch((e) => console.error('Could not load historical orders:', e));
  } catch (error) {
    $('login').hidden = false;
    $('app').hidden = true;
    $('loginMsg').textContent = error.message || 'Could not load Supabase data.';
  }
}

function go(page) {
  document.querySelectorAll('.page').forEach((element) => {
    element.hidden = element.id !== page;
  });

  document.querySelectorAll('#sideNav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });

  const [title, label] = pages[page] || pages.dashboard;
  $('pageTitle').textContent = title;
  $('pageName').textContent = label;
  render();
  if (page === 'customers' && !db.customerPaymentsLoaded) {
    API.getCustomerPayments().then((payments) => {
      db.customerPayments = payments || [];
      db.customerPaymentsLoaded = true;
      renderCustomerAccountsPage();
    }).catch((e) => console.error('Could not load customer payments:', e));
  }
  if (page === 'customers' && !db.customerOpeningBalancesLoaded) {
    API.getCustomerOpeningBalances().then((balances) => {
      db.customerOpeningBalances = balances || [];
      db.customerOpeningBalancesLoaded = true;
      renderCustomerAccountsPage();
    }).catch((e) => console.error('Could not load customer opening balances:', e));
  }
  if ((page === 'history' || page === 'reports' || page === 'receipt' || page === 'customers') && !db.orders.length) {
    API.get('orders').then((orders) => {
      db.orders = orders || [];
      db.lastReceipt = db.orders[0] || null;
      render();
    }).catch((e) => console.error('Could not load orders:', e));
  }
  if (page === 'movements' && !db.stockMovements.length) {
    API.get('stockMovements').then((rows) => {
      db.stockMovements = rows || [];
      render();
    }).catch((e) => console.error('Could not load movements:', e));
  }
}

function render() {
  renderProducts();
  renderSelect();
  renderCart();
  renderStats();
  renderDashboard();
  renderHistory();
  renderCustomerAccountsPage();
  renderReports();
  renderMovements();
  renderReceipt();
}

function renderStats() {
  const today = new Date().toDateString();
  const orders = db.orders.filter(
    (order) => new Date(order.date).toDateString() === today,
  );

  const stockUnits = db.products.reduce(
    (total, product) => total + Number(product.qty || 0),
    0,
  );

  const inventoryCost = db.products.reduce(
    (total, product) => total + Number(product.qty || 0) * Number(product.buy || 0),
    0,
  );

  const sales = orders.reduce((total, order) => total + Number(order.total || 0), 0);
  const profit = orders.reduce((total, order) => total + Number(order.profit || 0), 0);
  const totalProfit = db.orders.reduce((total, order) => total + Number(order.profit || 0), 0);

  $('sProducts').textContent = db.products.length;
  $('sUnits').textContent = stockUnits;
  $('sCost').textContent = money(inventoryCost);
  $('sSales').textContent = money(sales);
  $('sProfit').textContent = money(profit);
  $('sTotalProfit').textContent = money(totalProfit);
  $('sOrders').textContent = `${orders.length} הזמנות`;
  $('sLow').textContent = db.products.filter(
    (product) => Number(product.qty) <= Number(product.min),
  ).length;
}

function renderDashboard() {
  const lowStock = [...db.products]
    .filter((product) => Number(product.qty) <= Number(product.min))
    .sort((a, b) => Number(a.qty) - Number(b.qty));

  $('lowStockList').innerHTML = lowStock.length
    ? lowStock.map((product) => `
        <article class="list-row">
          <section>
            <b>${escapeHtml(product.name)}</b>
            <small>${escapeHtml(product.brand || '')} · minimum ${product.min}</small>
          </section>
          <span class="low-num">${product.qty} left</span>
        </article>
      `).join('')
    : '<p class="empty">All products are above minimum stock.</p>';

  const recentOrders = [...db.orders]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 6);

  $('recentOrders').innerHTML = recentOrders.length
    ? recentOrders.map((order) => `
        <article class="list-row">
          <section>
            <b>${escapeHtml(order.id)}</b>
            <small>${new Date(order.date).toLocaleString()} · ${order.items.length} products</small>
          </section>
          <b>${money(order.total)}</b>
        </article>
      `).join('')
    : '<p class="empty">No orders yet.</p>';
}

function renderProducts() {
  const query = ($('search').value || '').toLowerCase();

  const products = db.products.filter((product) => {
    const text = [product.name, product.brand, product.type, product.variant, product.supplier]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return text.includes(query);
  });

  $('productRows').innerHTML = products.length
    ? products.map((product) => {
        const status = product.qty === 0
          ? ['out', 'אזל מהמלאי']
          : product.qty <= product.min
            ? ['low', 'מלאי נמוך']
            : ['ok', 'במלאי'];

        return `
          <tr>
            <td class="product-name">
              <b>${escapeHtml(product.name)}</b>
              <small>${escapeHtml(product.brand || '')}</small>
            </td>
            <td>${escapeHtml(product.type || '')}</td>
            <td>${money(product.buy)}</td>
            <td>${money(product.sell)}</td>
            <td><b>${product.qty}</b></td>
            <td>${money(product.qty * product.buy)}</td>
            <td><span class="pill ${status[0]}">${status[1]}</span></td>
            <td>
              <section class="row-actions">
                <button data-action="edit-product" data-id="${product.id}">Edit</button>
                <button class="outline" data-action="delete-product" data-id="${product.id}">Delete</button>
              </section>
            </td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="8" class="empty">No products found.</td></tr>';
}

function getCustomerPrice(product) {
  const prices = window.customerPriceMap || {};
  const special = prices[String(product.id)];
  return Number.isFinite(Number(special)) ? Number(special) : Number(product.sell);
}

function renderSelect() {
  const available = db.products.filter((product) => Number(product.qty) > 0);

  $('orderProduct').innerHTML = available.length
    ? available.map((product) => {
        const price = getCustomerPrice(product);
        return `
        <option value="${product.id}">
          ${escapeHtml(product.name)} — ${product.qty} available — ${money(price)}
        </option>`;
      }).join('')
    : '<option value="">No stock available</option>';
}

function calculateCart() {
  const subtotal = cart.reduce(
    (total, item) => total + Number(item.qty) * Number(item.sell),
    0,
  );

  const cost = cart.reduce(
    (total, item) => total + Number(item.qty) * Number(item.buy),
    0,
  );

  const discount = Math.max(0, Number($('discount').value || 0));
  const total = Math.max(0, subtotal - discount);

  return { subtotal, cost, discount, total, profit: total - cost };
}

function renderCart() {
  const totals = calculateCart();

  $('cart').innerHTML = cart.length
    ? cart.map((item, index) => `
        <article class="cartitem">
          <section>
            <b>${escapeHtml(item.name)}</b>
            <small>${item.qty} × ${money(item.sell)}</small>
          </section>
          <b class="price">${money(item.qty * item.sell)}</b>
          <button class="icon-btn" data-action="remove-cart" data-index="${index}">×</button>
        </article>
      `).join('')
    : '<p class="empty">No products in this order.</p>';

  $('subtotal').textContent = money(totals.subtotal);
  $('total').textContent = money(totals.total);
  $('orderCost').textContent = money(totals.cost);
  $('profit').textContent = money(totals.profit);
}

function renderHistory() {
  const query = ($('orderSearch').value || '').toLowerCase();

  const orders = [...db.orders]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .filter((order) => order.id.toLowerCase().includes(query));

  $('orderRows').innerHTML = orders.length
    ? orders.map((order) => `
        <tr>
          <td><b>${escapeHtml(order.id)}</b></td>
          <td>${new Date(order.date).toLocaleString()}</td>
          <td>${order.items.reduce((total, item) => total + item.qty, 0)}</td>
          <td>${money(order.sub)}</td>
          <td>${money(order.discount)}</td>
          <td><b>${money(order.total)}</b></td>
          <td class="profit-row"><b>${money(order.profit)}</b></td>
          <td>
            <button data-action="view-receipt" data-id="${escapeHtml(order.id)}">Receipt</button>
            <button class="outline danger" data-action="delete-order" data-id="${escapeHtml(order.id)}">Delete</button>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="8" class="empty">No orders found.</td></tr>';
}

let reportFromDate = '';
let reportToDate = '';

function getReportOrders() {
  const from = reportFromDate ? new Date(`${reportFromDate}T00:00:00`) : null;
  const to = reportToDate ? new Date(`${reportToDate}T23:59:59.999`) : null;

  return db.orders.filter((order) => {
    const date = new Date(order.date);
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });
}

function localDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatReportDate(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function updateReportRangeLabel() {
  const label = $('reportRangeLabel');
  if (!label) return;

  if (!reportFromDate && !reportToDate) {
    label.textContent = 'كل الفترات';
    return;
  }

  label.textContent = `${formatReportDate(reportFromDate) || '—'} → ${formatReportDate(reportToDate) || '—'}`;
}

function applyReportDates(from, to) {
  const fromValue = from || '';
  const toValue = to || '';

  if (fromValue && toValue && fromValue > toValue) {
    $('reportFilterMsg').textContent = 'تاريخ البداية يجب أن يكون قبل أو يساوي تاريخ النهاية.';
    return false;
  }

  reportFromDate = fromValue;
  reportToDate = toValue;
  $('reportFrom').value = reportFromDate;
  $('reportTo').value = reportToDate;
  $('reportFilterMsg').textContent = '';
  updateReportRangeLabel();
  renderReports();
  return true;
}

function renderReports() {
  const orders = getReportOrders();
  const sales = orders.reduce((total, order) => total + Number(order.total || 0), 0);
  const profit = orders.reduce((total, order) => total + Number(order.profit || 0), 0);

  $('rSales').textContent = money(sales);
  $('rProfit').textContent = money(profit);
  $('rOrders').textContent = orders.length;
  $('rAvg').textContent = money(orders.length ? sales / orders.length : 0);

  const soldByProduct = {};

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      soldByProduct[item.name] = (soldByProduct[item.name] || 0) + Number(item.qty || 0);
    });
  });

  const bestSellers = Object.entries(soldByProduct)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  $('bestSellers').innerHTML = bestSellers.length
    ? bestSellers.map(([name, quantity], index) => `
        <article class="list-row">
          <section><b>#${index + 1} ${escapeHtml(name)}</b></section>
          <b>${quantity} units</b>
        </article>
      `).join('')
    : '<p class="empty">لا توجد مبيعات في الفترة المحددة.</p>';
}


function getCustomerAccount(customerId) {
  const customer = (db.customers || []).find(c => String(c.id) === String(customerId));
  if (!customer) return null;
  const orders = (db.orders || []).filter(o => String(o.customerId || '') === String(customerId));
  const payments = (db.customerPayments || []).filter(p => String(p.customer_id) === String(customerId));
  const opening = (db.customerOpeningBalances || []).find(p => String(p.customer_id) === String(customerId));
  const openingBalance = Number(opening?.amount || 0);
  const sales = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const paid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const balance = openingBalance + sales - paid;
  return { customer, orders, payments, opening, openingBalance, sales, paid, due: Math.max(0, balance), credit: Math.max(0, -balance) };
}

function renderCustomerAccountsPage() {
  const search = String($('customerAccountSearch')?.value || '').trim().toLowerCase();
  const rows = (db.customers || []).map(customer => {
    const account = getCustomerAccount(customer.id);
    return account;
  }).filter(account => {
    if (!search) return true;
    return [account.customer.name, account.customer.phone].filter(Boolean).join(' ').toLowerCase().includes(search);
  }).sort((a, b) => a.customer.name.localeCompare(b.customer.name));

  const totalSales = rows.reduce((s, a) => s + a.sales, 0);
  const totalPaid = rows.reduce((s, a) => s + a.paid, 0);
  const totalDue = rows.reduce((s, a) => s + a.due, 0);
  $('caCustomers').textContent = rows.length;
  $('caSales').textContent = money(totalSales);
  $('caPaid').textContent = money(totalPaid);
  $('caOutstanding').textContent = money(totalDue);

  $('customerAccountRows').innerHTML = rows.length ? rows.map(account => `
    <tr>
      <td><b>${escapeHtml(account.customer.name)}</b></td>
      <td>${escapeHtml(account.customer.phone || '—')}</td>
      <td>${account.orders.length}</td>
      <td>${money(account.sales)}</td>
      <td>${money(account.paid)}</td>
      <td><b class="${account.due > 0 ? 'customer-due' : 'customer-paid'}">${account.credit > 0 ? '+' + money(account.credit) : money(account.due)}</b></td>
      <td><section class="row-actions"><button data-action="view-customer-account" data-id="${escapeHtml(account.customer.id)}">الحساب</button><button class="outline" data-action="add-customer-payment" data-id="${escapeHtml(account.customer.id)}">＋ دفعة</button><button class="outline" data-action="manage-customer-prices-page" data-id="${escapeHtml(account.customer.id)}">💰 أسعار</button><button class="outline danger" data-action="delete-customer" data-id="${escapeHtml(account.customer.id)}">حذف</button></section></td>
    </tr>
  `).join('') : '<tr><td colspan="7" class="empty">لا يوجد عملاء.</td></tr>';
}

function openCustomerAccount(customerId) {
  const account = getCustomerAccount(customerId);
  if (!account) return;
  $('accountCustomerName').textContent = account.customer.name;
  $('accountCustomerPhone').textContent = account.customer.phone || '';
  $('accountSales').textContent = money(account.sales);
  $('accountPaid').textContent = money(account.paid);
  $('accountDue').textContent = account.credit > 0 ? '+' + money(account.credit) : money(account.due);
  $('accountDue').parentElement?.classList.toggle('balance-credit', account.credit > 0);
  $('accountDue').previousElementSibling.textContent = account.credit > 0 ? 'الرصيد الدائن' : 'المستحق';
  $('accountOpeningBalance').dataset.customerId = account.customer.id;
  $('accountAddPayment').dataset.customerId = account.customer.id;
  $('accountManagePrices').dataset.customerId = account.customer.id;
  $('accountPrintStatement').dataset.customerId = account.customer.id;

  const ledger = [
    ...(account.openingBalance !== 0 ? [{ date: account.opening?.updated_at || account.customer.createdAt || new Date().toISOString(), type: 'opening', id: 'opening', amount: account.openingBalance, note: 'رصيد افتتاحي' }] : []),
    ...account.orders.map(order => ({ date: order.date, type: 'order', id: order.id, amount: Number(order.total || 0), note: `Order #${order.id}` })),
    ...account.payments.map(payment => ({ date: payment.created_at, type: 'payment', id: payment.id, amount: Number(payment.amount || 0), note: payment.note || 'Payment' }))
  ].sort((a,b) => new Date(a.date) - new Date(b.date));

  let balance = 0;
  $('accountLedger').innerHTML = ledger.length ? ledger.map(entry => {
    balance += entry.type === 'payment' ? -entry.amount : entry.amount;
    const running = balance >= 0 ? money(balance) : '+' + money(Math.abs(balance)) + ' دائن';
    return `<article class="ledger-row ${entry.type}">
      <section><b>${escapeHtml(entry.note)}</b><small>${new Date(entry.date).toLocaleString()}</small></section>
      <b>${entry.type === 'payment' ? '-' : '+'}${money(entry.amount)}</b>
      <span>${running}</span>
      ${entry.type === 'payment' ? `<button type="button" class="outline danger ledger-delete-payment" data-payment-id="${escapeHtml(entry.id)}" data-customer-id="${escapeHtml(customerId)}">حذف</button>` : ''}
    </article>`;
  }).join('') : '<p class="empty">لا يوجد نشاط على الحساب.</p>';

  // Bind payment delete buttons directly after rendering them. This avoids relying on
  // delegated clicks or inline handlers, which can fail inside dynamically-rendered dialogs.
  $('accountLedger').querySelectorAll('.ledger-delete-payment').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDeletePaymentConfirm(button.dataset.paymentId, button.dataset.customerId);
    });
  });

  $('customerAccountDialog')?.showModal();
}

function printCustomerStatement(customerId) {
  const account = getCustomerAccount(customerId);
  if (!account) return;

  const customerName = escapeHtml(account.customer.name);
  const customerPhone = escapeHtml(account.customer.phone || '—');
  const ledger = [
    ...(account.openingBalance !== 0 ? [{ date: account.opening?.updated_at || account.customer.createdAt || new Date().toISOString(), type: 'opening', reference: 'رصيد افتتاحي', amount: account.openingBalance }] : []),
    ...account.orders.map(order => ({
      date: order.date,
      type: 'order',
      reference: `Order #${order.id}`,
      amount: Number(order.total || 0),
    })),
    ...account.payments.map(payment => ({
      date: payment.created_at,
      type: 'payment',
      reference: payment.note || 'Payment',
      amount: Number(payment.amount || 0),
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let balance = 0;
  const rows = ledger.map(entry => {
    balance += entry.type === 'payment' ? -entry.amount : entry.amount;
    const running = balance >= 0
      ? money(balance)
      : '+' + money(Math.abs(balance)) + ' دائن';
    return `<tr>
      <td>${new Date(entry.date).toLocaleString()}</td>
      <td>${escapeHtml(entry.reference)}</td>
      <td>${entry.type === 'order' ? money(entry.amount) : '—'}</td>
      <td>${entry.type === 'payment' ? money(entry.amount) : '—'}</td>
      <td><b>${running}</b></td>
    </tr>`;
  }).join('');

  const finalBalance = account.credit > 0
    ? '+' + money(account.credit) + ' دائن'
    : money(account.due);
  const finalLabel = account.credit > 0 ? 'الرصيد الدائن' : 'المبلغ المستحق';
  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) {
    alert(window.t('Please allow pop-ups to print the statement.'));
    return;
  }

  printWindow.document.write(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>كشف حساب - ${customerName}</title>
<style>
*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;padding:30px;color:#111;background:#fff}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:18px;margin-bottom:25px}
h1{margin:0 0 8px;font-size:28px}h2{margin:0 0 5px}.muted{color:#666;margin:4px 0}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:25px}.box{border:1px solid #ddd;border-radius:10px;padding:15px}.box span{display:block;color:#666;font-size:13px;margin-bottom:7px}.box strong{font-size:20px}
table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:11px 8px;text-align:right}th{background:#f4f4f4}
.footer{margin-top:30px;border-top:1px solid #ddd;padding-top:15px;color:#666;font-size:13px}
@media print{body{padding:15px}}
</style></head><body>
<section class="header"><section><h1>كشف حساب العميل</h1><h2>${customerName}</h2><p class="muted">الهاتف: ${customerPhone}</p></section>
<section><p class="muted">تاريخ الكشف</p><b>${new Date().toLocaleString()}</b></section></section>
<section class="summary">
<section class="box"><span>إجمالي المبيعات</span><strong>${money(account.sales)}</strong></section>
<section class="box"><span>إجمالي المدفوع</span><strong>${money(account.paid)}</strong></section>
<section class="box"><span>${finalLabel}</span><strong>${finalBalance}</strong></section>
</section>
<h2>تفاصيل الحساب</h2><table><thead><tr><th>التاريخ</th><th>البيان</th><th>المبيعات</th><th>الدفعات</th><th>الرصيد</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">لا يوجد نشاط على الحساب.</td></tr>'}</tbody></table>
<section class="footer"><p>كشف حساب إداري — Cigarette Shop</p><p>هذا الكشف للاستخدام الإداري والمحاسبي.</p></section>
<script>window.onload=function(){window.print();};<\/script></body></html>`);
  printWindow.document.close();
}

let pendingOpeningCustomerId = null;
function openCustomerOpeningBalance(customerId) {
  const account = getCustomerAccount(customerId);
  if (!account) return;
  pendingOpeningCustomerId = String(customerId);
  $('openingCustomerLabel').textContent = account.customer.name;
  $('openingAmount').value = account.openingBalance > 0 ? account.openingBalance : '';
  $('openingCredit').value = account.openingBalance < 0 ? Math.abs(account.openingBalance) : '';
  $('openingNote').value = account.opening?.note || 'رصيد سابق قبل استخدام النظام';
  $('openingMode').value = account.openingBalance < 0 ? 'credit' : 'due';
  $('openingDueFields').hidden = account.openingBalance < 0;
  $('openingCreditFields').hidden = account.openingBalance >= 0;
  $('customerOpeningDialog')?.showModal();
}
function closeCustomerOpeningBalance() {
  pendingOpeningCustomerId = null;
  const dialog = $('customerOpeningDialog');
  if (dialog?.open) dialog.close();
}
async function saveCustomerOpeningBalance(event) {
  event.preventDefault();
  const customerId = pendingOpeningCustomerId;
  if (!customerId) return;
  const mode = $('openingMode').value;
  const raw = Number(mode === 'credit' ? $('openingCredit').value : $('openingAmount').value);
  if (!Number.isFinite(raw) || raw < 0) { alert(window.t('Enter a valid opening balance.')); return; }
  const amount = mode === 'credit' ? -raw : raw;
  try {
    if (raw === 0) await API.deleteCustomerOpeningBalance(customerId);
    else await API.saveCustomerOpeningBalance(customerId, amount, $('openingNote').value.trim());
    db.customerOpeningBalances = await API.getCustomerOpeningBalances();
    closeCustomerOpeningBalance();
    closeCustomerAccount();
    renderCustomerAccountsPage();
    openCustomerAccount(customerId);
  } catch (error) {
    console.error(error);
    alert(error.message || window.t('Could not save opening balance.'));
  }
}

function closeCustomerAccount() {
  const dialog = $('customerAccountDialog');
  if (dialog?.open) dialog.close();
}

let pendingPaymentCustomerId = null;
function openCustomerPayment(customerId) {
  const account = getCustomerAccount(customerId);
  if (!account) return;
  if (account.due <= 0) {
    alert(account.credit > 0 ? 'هذا العميل لديه رصيد دائن ولا يوجد مبلغ مستحق حالياً.' : 'لا يوجد مبلغ مستحق على هذا العميل.');
    return;
  }
  pendingPaymentCustomerId = String(customerId);
  $('paymentCustomerLabel').textContent = account.customer.name;
  $('paymentCurrentDue').textContent = money(account.due);
  $('paymentAmount').value = '';
  $('paymentNote').value = '';
  $('customerPaymentDialog')?.showModal();
  setTimeout(() => $('paymentAmount')?.focus(), 50);
}

function closeCustomerPayment() {
  pendingPaymentCustomerId = null;
  const dialog = $('customerPaymentDialog');
  if (dialog?.open) dialog.close();
}

async function saveCustomerPayment(event) {
  event.preventDefault();
  const customerId = pendingPaymentCustomerId;
  if (!customerId) return;
  const amount = Number($('paymentAmount').value);
  if (!Number.isFinite(amount) || amount <= 0) {
    alert(window.t('أدخل مبلغ دفعة صحيح.'));
    return;
  }
  try {
    await API.recordCustomerPayment(customerId, amount, $('paymentNote').value.trim());
    // Re-fetch from Supabase so Paid/Remaining/Credit update immediately and accurately.
    db.customerPayments = await API.getCustomerPayments();
    db.customerOpeningBalances = await API.getCustomerOpeningBalances();
    closeCustomerPayment();
    closeCustomerAccount();
    renderCustomerAccountsPage();
    openCustomerAccount(customerId);
  } catch (error) {
    console.error(error);
    alert(error.message || 'Could not record payment.');
  }
}

let pendingDeletePaymentId = null;
let pendingDeletePaymentCustomerId = null;
function openDeletePaymentConfirm(paymentId, customerId) {
  const payment = (db.customerPayments || []).find(p => String(p.id) === String(paymentId));
  if (!payment) return;
  pendingDeletePaymentId = String(paymentId);
  pendingDeletePaymentCustomerId = String(customerId);
  $('deletePaymentAmount').textContent = money(Number(payment.amount || 0));
  $('deletePaymentNote').textContent = payment.note || 'دفعة';
  $('deletePaymentDialog')?.showModal();
}
function closeDeletePaymentConfirm() {
  pendingDeletePaymentId = null;
  pendingDeletePaymentCustomerId = null;
  const dialog = $('deletePaymentDialog');
  if (dialog?.open) dialog.close();
}
async function confirmDeletePayment() {
  const paymentId = pendingDeletePaymentId;
  const customerId = pendingDeletePaymentCustomerId;
  if (!paymentId) return;
  try {
    await API.deleteCustomerPayment(paymentId);
    db.customerPayments = await API.getCustomerPayments();
    closeDeletePaymentConfirm();
    closeCustomerAccount();
    renderCustomerAccountsPage();
    if (customerId) openCustomerAccount(customerId);
  } catch (error) {
    console.error(error);
    alert(error.message || 'Could not delete payment.');
  }
}

let pendingDeleteCustomerId = null;
function openDeleteCustomerConfirm(customerId) {
  const customer = (db.customers || []).find(c => String(c.id) === String(customerId));
  if (!customer) return;
  pendingDeleteCustomerId = String(customer.id);
  $('deleteCustomerName').textContent = customer.name;
  $('deleteCustomerDialog')?.showModal();
}
function closeDeleteCustomerConfirm() {
  pendingDeleteCustomerId = null;
  const dialog = $('deleteCustomerDialog');
  if (dialog?.open) dialog.close();
}
async function confirmDeleteCustomer() {
  const id = pendingDeleteCustomerId;
  if (!id) return;
  try {
    await API.deleteCustomer(id);
    db.customers = db.customers.filter(c => String(c.id) !== id);
    db.customerPayments = db.customerPayments.filter(p => String(p.customer_id) !== id);
    closeDeleteCustomerConfirm();
    renderCustomerAccountsPage();
    if (String($('order-customer')?.value || '') === id) {
      $('order-customer').value = '';
      window.customerPriceMap = {};
      if (window.showOrderCustomerInfo) window.showOrderCustomerInfo();
    }
  } catch (error) {
    console.error(error);
    alert(error.message || 'Could not delete customer.');
  }
}

function manageCustomerPricesFromPage(customerId) {
  if (window.openCustomerPricesForCustomer) window.openCustomerPricesForCustomer(customerId);
}

function renderMovements() {
  const movements = db.stockMovements.slice(0, 100);

  $('movementRows').innerHTML = movements.length
    ? movements.map((movement) => `
        <tr>
          <td>${new Date(movement.date).toLocaleString()}</td>
          <td><b>${escapeHtml(movement.productName)}</b></td>
          <td><b>${movement.change > 0 ? '+' : ''}${movement.change}</b></td>
          <td>${escapeHtml(movement.reason)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="empty">No stock movements yet.</td></tr>';
}

function receiptHtml(receipt) {
  const tr = (text) => window.t ? window.t(text) : text;
  const groupedByType = {};
  (receipt.items || []).forEach((item) => {
    const type = String(item.type || 'Other').trim() || 'Other';
    if (!groupedByType[type]) groupedByType[type] = { qty: 0, total: 0 };
    groupedByType[type].qty += Number(item.qty || 0);
    groupedByType[type].total += Number(item.qty || 0) * Number(item.sell || 0);
  });

  const typeTotals = Object.entries(groupedByType).map(([type, data]) => `
    <tr><td>${escapeHtml(type)}</td><td>${data.qty}</td><td>${money(data.total)}</td></tr>
  `).join('');

  return `
    <article>
      <h2>CIGARETTE SHOP</h2>
      <p class="muted">${escapeHtml(tr('Order'))} #${escapeHtml(receipt.id)} · ${new Date(receipt.date).toLocaleString()}</p>
      ${receipt.customerName && receipt.customerName !== 'Walk-in / No customer' ? `<p>${escapeHtml(tr('Customer'))}: <b>${escapeHtml(receipt.customerName)}</b></p>` : ''}
      <table>
        <thead><tr><th>${escapeHtml(tr('Item'))}</th><th>${escapeHtml(tr('Qty'))}</th><th>${escapeHtml(tr('Selling Price'))}</th><th>${escapeHtml(tr('Total'))}</th></tr></thead>
        <tbody>
          ${(receipt.items || []).map((item) => `
            <tr>
              <td>${escapeHtml(item.name)}</td><td>${item.qty}</td><td>${money(item.sell)}</td><td>${money(Number(item.qty || 0) * Number(item.sell || 0))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <h3 style="margin:22px 0 10px">${escapeHtml(tr('Totals by Type'))}</h3>
      <table>
        <thead><tr><th>${escapeHtml(tr('Type'))}</th><th>${escapeHtml(tr('Total Qty'))}</th><th>${escapeHtml(tr('Total'))}</th></tr></thead>
        <tbody>${typeTotals || `<tr><td colspan="3">${escapeHtml(tr('No items.'))}</td></tr>`}</tbody>
      </table>
      <section class="receipt-total">
        <p>${escapeHtml(tr('Subtotal'))}: <b>${money(receipt.sub)}</b></p>
        <p>${escapeHtml(tr('Discount'))}: <b>${money(receipt.discount)}</b></p>
        <p>${escapeHtml(tr('Total'))}: <b>${money(receipt.total)}</b></p>
      </section>
      <p class="muted">${escapeHtml(tr('Thank you'))}</p>
    </article>
  `;
}
function renderReceipt() {
  $('receiptBox').innerHTML = db.lastReceipt
    ? receiptHtml(db.lastReceipt)
    : '<p class="empty">No receipt yet.</p>';
}

function resetProductForm() {
  $('productForm').reset();
  $('pId').value = '';
  $('pMin').value = 5;
}

async function openStockDialog() {
  const select = $('stockProduct');
  const products = db.products.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  select.innerHTML = products.length
    ? products.map(p => `<option value="${p.id}">${escapeHtml(p.name)} — ${p.qty} in stock</option>`).join('')
    : '<option value="">No products yet</option>';

  $('stockSupplier').innerHTML = '<option value="">No supplier</option>' +
    (db.suppliers || []).map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  const first = products[0];
  $('stockQty').value = 1;
  $('stockBuy').value = first ? Number(first.buy || 0) : 0;
  $('stockDialog').showModal();
}

function closeStockDialog() { $('stockDialog').close(); }

async function saveStock(event) {
  event.preventDefault();
  const productId = $('stockProduct').value;
  const quantity = Number($('stockQty').value);
  const purchaseCost = Number($('stockBuy').value);
  const supplierId = $('stockSupplier').value || null;
  const product = db.products.find(p => String(p.id) === String(productId));

  if (!product) return alert(window.t('Please select a product.'));
  if (!Number.isInteger(quantity) || quantity < 1) return alert(window.t('Quantity must be at least 1.'));
  if (!Number.isFinite(purchaseCost) || purchaseCost < 0) return alert(window.t('Purchase cost is invalid.'));

  try {
    const updated = await API.patchProductStock(product.id, quantity, 'Stock purchase', purchaseCost, supplierId);
    const index = db.products.findIndex(p => String(p.id) === String(product.id));
    if (index >= 0) db.products[index] = updated;
    closeStockDialog();
    render();
    alert(`Added ${quantity} to ${product.name}.`);
  } catch (error) {
    console.error('Add stock failed:', error);
    alert(error?.message || 'Could not add stock.');
  }
}

function openProductDialog(product = null) {
  resetProductForm();

  if (product) {
    $('pId').value = product.id;
    $('pName').value = product.name;
    $('pBrand').value = product.brand || '';
    $('pType').value = product.type || '';
    $('pVariant').value = product.variant || '';
    $('pSupplier').value = product.supplier || '';
    $('pBuy').value = product.buy;
    $('pSell').value = product.sell;
    $('pQty').value = product.qty;
    $('pMin').value = product.min;
  }

  $('productDialog').showModal();
}

function closeProductDialog() {
  $('productDialog').close();
}

async function saveProduct(event) {
  event.preventDefault();

  const id = $('pId').value.trim();
  const product = {
    id: id || '',
    name: $('pName').value.trim(),
    brand: $('pBrand').value.trim(),
    type: $('pType').value,
    variant: $('pVariant').value.trim(),
    supplier: $('pSupplier').value.trim(),
    buy: Number($('pBuy').value),
    sell: Number($('pSell').value),
    qty: Number($('pQty').value),
    min: Number($('pMin').value),
  };

  if (!product.name || !Number.isFinite(product.buy) || !Number.isFinite(product.sell)) {
    alert('Please complete the required product fields.');
    return;
  }

  if (hasDuplicateProduct(db, product, id)) {
    alert(window.t('This product already exists. Use Add Stock instead of creating a duplicate.'));
    return;
  }

  try {
    if (id) {
      const updated = await API.put('products', id, product);
      const index = db.products.findIndex(p => String(p.id) === String(id));
      if (index >= 0) db.products[index] = updated;
    } else {
      // One database round-trip for a new product + opening stock.
      const created = await API.createProductFast(product);
      db.products.push(created);
      if (product.supplier) {
        const existing = (db.suppliers || []).find(s => String(s.name).trim().toLowerCase() === product.supplier.trim().toLowerCase());
        if (!existing) db.suppliers = [...(db.suppliers || []), { id: created.supplierId || '', name: product.supplier }];
      }
    }

    closeProductDialog();
    render();
  } catch (error) {
    console.error('Save product failed:', error);
    alert(error?.message || 'Could not save product.');
  }
}

let pendingDeleteOrderId = null;

function openDeleteOrderConfirm(id) {
  const order = db.orders.find((item) => String(item.id) === String(id));
  if (!order) return;
  pendingDeleteOrderId = order.id;
  const numberEl = document.getElementById('deleteOrderNumber');
  if (numberEl) numberEl.textContent = `#${order.id}`;
  const dialog = document.getElementById('deleteOrderDialog');
  if (dialog?.showModal) dialog.showModal();
}

function closeDeleteOrderConfirm() {
  pendingDeleteOrderId = null;
  const dialog = document.getElementById('deleteOrderDialog');
  if (dialog?.open) dialog.close();
}

async function deleteOrder(id) {
  const order = db.orders.find((item) => String(item.id) === String(id));
  if (!order) return;

  try {
    await API.deleteOrder(order.id);
    db.orders = db.orders.filter((item) => String(item.id) !== String(order.id));
    if (String(db.lastReceipt?.id) === String(order.id)) {
      db.lastReceipt = db.orders[0] || null;
    }
    renderHistory();
    renderReports();
    renderDashboard();
    alert(window.t('Order deleted and stock restored.'));
  } catch (error) {
    console.error(error);
    alert(error.message || 'Could not delete order.');
  }
}

let appConfirmResolver = null;
function openAppConfirm(message, title = 'Confirmation') {
  const dialog = $('appConfirmDialog');
  if (!dialog) return Promise.resolve(false);
  $('appConfirmTitle').textContent = window.t(title);
  $('appConfirmMessage').textContent = window.t(message);
  dialog.showModal();
  return new Promise((resolve) => { appConfirmResolver = resolve; });
}
function closeAppConfirm(result = false) {
  const dialog = $('appConfirmDialog');
  if (dialog?.open) dialog.close();
  const resolve = appConfirmResolver;
  appConfirmResolver = null;
  resolve?.(result);
}

async function deleteProduct(id) {
  const product = db.products.find((item) => String(item.id) === String(id));
  if (!product) return;

  if (!(await openAppConfirm(`${window.t('Delete this product?')} ${product.name}`, 'Delete Product'))) return;

  try {
    await API.delete('products', id);
    db.products = db.products.filter((item) => String(item.id) !== String(id));
    cart = cart.filter((item) => String(item.id) !== String(id));
    render();
  } catch (error) {
    console.error('Delete product failed:', error);
    alert(`${window.t('Could not delete product.')} ${error?.message || ''}`);
  }
}

function addToCart() {
  const product = db.products.find(
    (item) => String(item.id) === String($('orderProduct').value),
  );

  const quantity = Number($('orderQty').value);
  const existing = cart.find((item) => item.id === product?.id);
  const alreadyInCart = existing?.qty || 0;

  if (!product || quantity < 1 || alreadyInCart + quantity > product.qty) {
    alert(window.t('Not enough stock.'));
    return;
  }

  const customerPrice = getCustomerPrice(product);

  if (existing) {
    existing.qty += quantity;
  } else {
    cart.push({ ...product, sell: customerPrice, sellBase: Number(product.sell), qty: quantity });
  }

  renderCart();
}

function clearCart() {
  cart = [];
  $('discount').value = 0;
  renderCart();
}

async function completeOrder() {
  if (!cart.length) {
    alert(window.t('הוסף מוצרים תחילה.'));
    return;
  }

  const totals = calculateCart();

  if (totals.discount > totals.subtotal) {
    alert(window.t('Discount cannot exceed subtotal.'));
    return;
  }

  for (const item of cart) {
    const product = db.products.find((entry) => entry.id === item.id);

    if (!product || product.qty < item.qty) {
      alert(window.t('המלאי השתנה. בדוק את ההזמנה מחדש.'));
      return;
    }
  }

  const selectedCustomer = window.getSelectedCustomer ? window.getSelectedCustomer() : null;

  const order = {
    id: `R${Date.now().toString().slice(-8)}`,
    date: new Date().toISOString(),
    customerId: selectedCustomer?.id || "",
    customerName: selectedCustomer?.name || "Walk-in / No customer",
    items: cart.map((item) => ({
      productId: item.id,
      name: item.name,
      qty: item.qty,
      buy: item.buy,
      sell: item.sell,
      type: item.type || 'Other',
    })),
    sub: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
    cost: totals.cost,
    profit: totals.profit,
  };

  try {
    const orderNumber = await API.completeOrder(order);
    cart = [];
    $('discount').value = 0;

    // Update local state immediately; do not re-query Supabase after a successful RPC.
    for (const item of order.items) {
      const product = db.products.find(p => String(p.id) === String(item.productId));
      if (product) product.qty = Math.max(0, Number(product.qty) - Number(item.qty));
    }
    db.orders = [order, ...db.orders.filter(o => String(o.id) !== String(orderNumber))];
    order.id = orderNumber;
    db.lastReceipt = order;
    render();
    go('receipt');
  } catch (error) {
    alert(error.message || 'Could not complete order.');
  }
}

function viewReceipt(id) {
  const order = db.orders.find((item) => item.id === id);

  if (!order) return;

  db.lastReceipt = order;
  go('receipt');
}

async function loadDemoData() {
  if (!(await openAppConfirm('Load demo products? This only works when inventory is empty.', 'Confirmation'))) return;

  const loaded = await API.seedDemo();

  if (!loaded) {
    alert(window.t('Demo data already exists.'));
    return;
  }

  await refresh();
}

function handleClick(event) {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) {
    go(pageButton.dataset.page);
    return;
  }

  const actionButton = event.target.closest('[data-action], .ledger-delete-payment');
  if (!actionButton) return;

  const { action, id, index, paymentId } = actionButton.dataset;


  if (action === 'edit-product') {
    const product = db.products.find((item) => String(item.id) === String(id));
    if (product) openProductDialog(product);
  }

  if (action === 'delete-product') {
    deleteProduct(id);
  }

  if (action === 'remove-cart') {
    cart.splice(Number(index), 1);
    renderCart();
  }

  if (action === 'view-receipt') {
    viewReceipt(id);
  }

  if (action === 'delete-order') {
    openDeleteOrderConfirm(id);
  }

  if (action === 'view-customer-account') {
    openCustomerAccount(id);
  }
  if (action === 'add-customer-payment') {
    openCustomerPayment(id);
  }
  if (action === 'manage-customer-prices-page') {
    manageCustomerPricesFromPage(id);
  }
  if (action === 'delete-customer') {
    openDeleteCustomerConfirm(id);
  }

  if (action === 'delete-payment' || actionButton.classList.contains('ledger-delete-payment')) {
    openDeletePaymentConfirm(actionButton.dataset.paymentId, actionButton.dataset.customerId);
  }

  if (action === 'confirm-delete-order') {
    const deleteId = pendingDeleteOrderId;
    if (deleteId != null) {
      closeDeleteOrderConfirm();
      deleteOrder(deleteId);
    }
  }
}

function init() {
  document.addEventListener('click', handleClick);

  $('cancelDeleteOrder')?.addEventListener('click', closeDeleteOrderConfirm);
  $('cancelDeleteOrderX')?.addEventListener('click', closeDeleteOrderConfirm);
  $('loginBtn').addEventListener('click', login);
  $('pass').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });

  $('logout').addEventListener('click', async () => {
    await API.logout();
    sessionStorage.removeItem(AUTH_KEY);
    location.reload();
  });

  $('search').addEventListener('input', renderProducts);
  $('orderSearch').addEventListener('input', renderHistory);
  $('reportApply')?.addEventListener('click', () => applyReportDates($('reportFrom').value, $('reportTo').value));
  $('reportToday')?.addEventListener('click', () => {
    const today = new Date();
    const value = localDateInputValue(today);
    applyReportDates(value, value);
  });
  $('reportThisMonth')?.addEventListener('click', () => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    applyReportDates(localDateInputValue(first), localDateInputValue(last));
  });
  $('reportClear')?.addEventListener('click', () => applyReportDates('', ''));
  $('reportFrom')?.addEventListener('change', () => { $('reportFilterMsg').textContent = ''; });
  $('reportTo')?.addEventListener('change', () => { $('reportFilterMsg').textContent = ''; });
  $('customerAccountSearch')?.addEventListener('input', renderCustomerAccountsPage);
  $('addCustomerFromCustomers')?.addEventListener('click', () => window.openCustomerDialogFromPage ? window.openCustomerDialogFromPage() : document.getElementById('add-customer-from-order')?.click());
  $('closeCustomerAccount')?.addEventListener('click', closeCustomerAccount);
  $('closeCustomerAccountX')?.addEventListener('click', closeCustomerAccount);
  $('customerAccountDialog')?.addEventListener('click', (event) => { if (event.target === $('customerAccountDialog')) closeCustomerAccount(); });
  $('accountOpeningBalance')?.addEventListener('click', () => openCustomerOpeningBalance($('accountOpeningBalance').dataset.customerId));
  $('customerOpeningForm')?.addEventListener('submit', saveCustomerOpeningBalance);
  $('cancelOpening')?.addEventListener('click', closeCustomerOpeningBalance);
  $('closeOpeningX')?.addEventListener('click', closeCustomerOpeningBalance);
  $('openingMode')?.addEventListener('change', () => {
    const credit = $('openingMode').value === 'credit';
    $('openingDueFields').hidden = credit;
    $('openingCreditFields').hidden = !credit;
  });
  $('customerOpeningDialog')?.addEventListener('click', (event) => { if (event.target === $('customerOpeningDialog')) closeCustomerOpeningBalance(); });
  $('accountAddPayment')?.addEventListener('click', () => openCustomerPayment($('accountAddPayment').dataset.customerId));
  $('accountManagePrices')?.addEventListener('click', () => manageCustomerPricesFromPage($('accountManagePrices').dataset.customerId));
  $('accountPrintStatement')?.addEventListener('click', () => printCustomerStatement($('accountPrintStatement').dataset.customerId));
  $('customerPaymentForm')?.addEventListener('submit', saveCustomerPayment);
  $('cancelCustomerPayment')?.addEventListener('click', closeCustomerPayment);
  $('closeCustomerPaymentX')?.addEventListener('click', closeCustomerPayment);
  $('customerPaymentDialog')?.addEventListener('click', (event) => { if (event.target === $('customerPaymentDialog')) closeCustomerPayment(); });
  $('cancelDeletePayment')?.addEventListener('click', closeDeletePaymentConfirm);
  $('cancelDeletePaymentX')?.addEventListener('click', closeDeletePaymentConfirm);
  $('confirmDeletePayment')?.addEventListener('click', confirmDeletePayment);
  $('deletePaymentDialog')?.addEventListener('click', (event) => { if (event.target === $('deletePaymentDialog')) closeDeletePaymentConfirm(); });
  $('cancelDeleteCustomer')?.addEventListener('click', closeDeleteCustomerConfirm);
  $('cancelDeleteCustomerX')?.addEventListener('click', closeDeleteCustomerConfirm);
  $('confirmDeleteCustomer')?.addEventListener('click', confirmDeleteCustomer);
  $('deleteCustomerDialog')?.addEventListener('click', (event) => { if (event.target === $('deleteCustomerDialog')) closeDeleteCustomerConfirm(); });
  $('discount').addEventListener('input', renderCart);

  $('addProduct').addEventListener('click', () => openProductDialog());
  $('addStock').addEventListener('click', openStockDialog);
  $('cancelStock').addEventListener('click', closeStockDialog);
  $('cancelStock2').addEventListener('click', closeStockDialog);
  $('stockForm').addEventListener('submit', saveStock);
  $('stockProduct').addEventListener('change', () => {
    const product = db.products.find(p => String(p.id) === String($('stockProduct').value));
    if (product) $('stockBuy').value = Number(product.buy || 0);
  });
  $('cancelProduct').addEventListener('click', closeProductDialog);
  $('cancelProduct2').addEventListener('click', closeProductDialog);
  $('productForm').addEventListener('submit', saveProduct);

  $('addToCart').addEventListener('click', addToCart);
  $('clearCart').addEventListener('click', clearCart);
  $('completeOrder').addEventListener('click', completeOrder);
  $('printLast').addEventListener('click', () => window.print());
  $('loadDemo').addEventListener('click', loadDemoData);
  $('backupExport')?.addEventListener('click', exportBackup);
  $('backupImport')?.addEventListener('click', () => $('backupFile')?.click());
  $('backupFile')?.addEventListener('change', importBackup);
  $('appConfirmOk')?.addEventListener('click', () => closeAppConfirm(true));
  $('appConfirmCancel')?.addEventListener('click', () => closeAppConfirm(false));
  $('appConfirmClose')?.addEventListener('click', () => closeAppConfirm(false));
  $('appConfirmDialog')?.addEventListener('click', (event) => { if (event.target === $('appConfirmDialog')) closeAppConfirm(false); });

  // Security: never auto-login from a persisted Supabase session.
  // Every fresh page load must show the login form and require email + password.
  if (window.supabaseClient?.auth) {
    window.supabaseClient.auth.signOut({ scope: 'local' }).finally(() => {
      sessionStorage.removeItem(AUTH_KEY);
      $('login').hidden = false;
      $('app').hidden = true;
    });
  } else {
    sessionStorage.removeItem(AUTH_KEY);
    $('login').hidden = false;
    $('app').hidden = true;
  }
}

// Backup & Restore — saves the app's local data into a portable JSON file.
function getBackupData() {
  const keys = ['cigarette_mock_api_v2', 'cig_admin_v1', 'cigarette_shop_language'];
  const data = {};
  keys.forEach((key) => {
    const value = localStorage.getItem(key);
    if (value !== null) {
      try { data[key] = JSON.parse(value); } catch { data[key] = value; }
    }
  });
  return data;
}

function exportBackup() {
  try {
    const payload = {
      app: 'Tobacco & Cigarette Shop Manager',
      version: 2,
      createdAt: new Date().toISOString(),
      data: getBackupData()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `TobaccoShop_Backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message || 'Could not create backup.');
  }
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || payload.app !== 'Tobacco & Cigarette Shop Manager' || !payload.data) {
      throw new Error('Invalid backup file.');
    }
    const allowedKeys = ['cigarette_mock_api_v2', 'cig_admin_v1', 'cigarette_shop_language'];
    const hasData = allowedKeys.some((key) => Object.prototype.hasOwnProperty.call(payload.data, key));
    if (!hasData) throw new Error('Backup contains no app data.');
    if (!(await openAppConfirm('Restore this backup? Current app data will be replaced.', 'Confirmation'))) return;
    allowedKeys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(payload.data, key)) {
        const value = payload.data[key];
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    });
    alert(window.t('Backup restored successfully.'));
    location.reload();
  } catch (error) {
    alert(error.message || 'Could not restore backup.');
  }
}


init();


// Prevent duplicate products: the same product name + variant is stored only once.
function hasDuplicateProduct(data, candidate, currentId = "") {
  const name = String(candidate.name || "").trim().toLowerCase();
  const variant = String(candidate.variant || "").trim().toLowerCase();
  return data.products.some((product) =>
    product.id !== currentId &&
    String(product.name || "").trim().toLowerCase() === name &&
    String(product.variant || "").trim().toLowerCase() === variant
  );
}



/* Brand selector — filters the product-name suggestions by brand. */
(function () {
  const brandProducts = {
    Marlboro: ["Marlboro Red","Marlboro Gold","Marlboro Touch","Marlboro Silver Blue","Marlboro Ice Blast","Marlboro Crafted"],
    Winston: ["Winston Red","Winston Blue","Winston Silver","Winston XS"],
    Camel: ["Camel Yellow","Camel Blue","Camel Silver"],
    Kent: ["Kent Blue","Kent Silver","Kent White"],
    "L&M": ["L&M Red","L&M Blue","L&M Silver","L&M Forward"],
    Parliament: ["Parliament Aqua Blue","Parliament Night Blue","Parliament Silver Blue"],
    Rothmans: ["Rothmans Red","Rothmans Blue","Rothmans Silver"],
    Davidoff: ["Davidoff Classic","Davidoff Gold","Davidoff Silver","Davidoff Reach"],
    "Pall Mall": ["Pall Mall Red","Pall Mall Blue","Pall Mall Silver"],
    "Lucky Strike": ["Lucky Strike Red","Lucky Strike Blue","Lucky Strike Silver"],
    Chesterfield: ["Chesterfield Red","Chesterfield Blue","Chesterfield Silver"],
    Vogue: ["Vogue Classic","Vogue Menthe","Vogue Blue"],
    West: ["West Red","West Blue","West Silver"],
    "Bond Street": ["Bond Street Red","Bond Street Blue"],
    LD: ["LD Red","LD Blue"],
    Gauloises: ["Gauloises Red","Gauloises Blue"],
    Sobranie: ["Sobranie Black","Sobranie Gold"],
    Mevius: ["Mevius Original","Mevius Sky Blue"],
    Esse: ["Esse Classic","Esse Blue","Esse Menthol"]
  };

  const brand = document.getElementById("product-brand");
  const name = document.getElementById("product-name");
  const list = document.getElementById("cigarette-names");

  function filterProducts() {
    if (!brand || !name || !list) return;
    const selected = brand.value;
    const products = brandProducts[selected] || [];
    list.innerHTML = products.map((product) => `<option value="${product}"></option>`).join("");
    if (selected && name.value && !products.includes(name.value)) name.value = "";
  }

  brand?.addEventListener("change", filterProducts);
  window.filterProductsByBrand = filterProducts;
  filterProducts();
})();

/* Product selector — Brand -> Product Name */
(function () {
  const productsByBrand = {
    Marlboro:["Marlboro Red","Marlboro Gold","Marlboro Touch","Marlboro Silver Blue","Marlboro Ice Blast","Marlboro Crafted"],
    Winston:["Winston Red","Winston Blue","Winston Silver","Winston XS"],
    Camel:["Camel Yellow","Camel Blue","Camel Silver"],
    Kent:["Kent Blue","Kent Silver","Kent White"],
    "L&M":["L&M Red","L&M Blue","L&M Silver","L&M Forward"],
    Parliament:["Parliament Aqua Blue","Parliament Night Blue","Parliament Silver Blue"],
    Rothmans:["Rothmans Red","Rothmans Blue","Rothmans Silver"],
    Davidoff:["Davidoff Classic","Davidoff Gold","Davidoff Silver","Davidoff Reach"],
    "Pall Mall":["Pall Mall Red","Pall Mall Blue","Pall Mall Silver"],
    "Lucky Strike":["Lucky Strike Red","Lucky Strike Blue","Lucky Strike Silver"],
    Chesterfield:["Chesterfield Red","Chesterfield Blue","Chesterfield Silver"],
    Vogue:["Vogue Classic","Vogue Menthe","Vogue Blue"],
    West:["West Red","West Blue","West Silver"],
    "Bond Street":["Bond Street Red","Bond Street Blue"],
    LD:["LD Red","LD Blue"],
    Gauloises:["Gauloises Red","Gauloises Blue"],
    Sobranie:["Sobranie Black","Sobranie Gold"],
    Mevius:["Mevius Original","Mevius Sky Blue"],
    Esse:["Esse Classic","Esse Blue","Esse Menthol"],
    Other:["Other"]
  };
  const brand=document.getElementById("product-brand");
  const name=document.getElementById("product-name");
  function updateProductNames(selectedName="") {
    if (!brand || !name) return;
    const list=productsByBrand[brand.value] || [];
    name.innerHTML='<option value="">Select product</option>'+list.map(v=>`<option value="${v}">${v}</option>`).join("");
    name.disabled=list.length===0;
    if (selectedName && list.includes(selectedName)) name.value=selectedName;
  }
  brand?.addEventListener("change",()=>updateProductNames());
  window.setProductBrandAndName=(b,n)=>{ if(brand){brand.value=b;updateProductNames(n);} };
  updateProductNames();
})();



/* Customers + automatic customer-specific price lists. */
(function () {
  const $ = (id) => document.getElementById(id);
  const priceCache = new Map();
  let activeCustomerId = '';
  let priceRequestToken = 0;

  async function loadCustomerPrices(customerId, force = false) {
    const id = String(customerId || '');
    if (!id) {
      window.customerPriceMap = {};
      activeCustomerId = '';
      renderSelect();
      renderCart();
      return {};
    }
    if (!force && priceCache.has(id)) {
      window.customerPriceMap = priceCache.get(id);
      activeCustomerId = id;
      renderSelect();
      renderCart();
      return window.customerPriceMap;
    }
    const token = ++priceRequestToken;
    try {
      const prices = await API.getCustomerPrices(id);
      if (token !== priceRequestToken) return {};
      priceCache.set(id, prices || {});
      window.customerPriceMap = prices || {};
      activeCustomerId = id;
      renderSelect();
      // If an order is already being built, switch its item prices to the newly selected customer's list.
      cart.forEach(item => {
        const special = window.customerPriceMap[String(item.id)];
        item.sell = Number.isFinite(Number(special)) ? Number(special) : Number(item.sellBase ?? item.sell);
      });
      renderCart();
      return window.customerPriceMap;
    } catch (error) {
      console.error('Could not load customer prices:', error);
      if (token === priceRequestToken) {
        window.customerPriceMap = {};
        renderSelect();
        renderCart();
      }
      return {};
    }
  }

  async function renderCustomers(cachedCustomers = null) {
    const select = $('order-customer');
    if (!select) return;
    try {
      const customers = cachedCustomers || await API.get('customers');
      db.customers = customers || [];
      const current = select.value;
      select.innerHTML = '<option value="">Walk-in / No customer</option>' +
        customers.map((customer) =>
          `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}${customer.phone ? ` — ${escapeHtml(customer.phone)}` : ''}</option>`
        ).join('');
      if (customers.some((customer) => String(customer.id) === String(current))) select.value = current;
      showCustomerInfo();
      await loadCustomerPrices(select.value || '');
    } catch (error) {
      console.error('Could not load customers:', error);
    }
  }

  function getSelectedCustomer() {
    const id = $('order-customer')?.value || '';
    if (!id) return null;
    return (db.customers || []).find((customer) => String(customer.id) === String(id)) || null;
  }

  function showCustomerInfo() {
    const info = $('selected-customer-info');
    const manage = $('manage-customer-prices');
    if (!info) return;
    const id = $('order-customer')?.value || '';
    if (!id) {
      info.innerHTML = '<span class="customer-dot"></span><span>No customer selected — this will be a walk-in order.</span>';
      if (manage) manage.disabled = true;
      return;
    }
    const option = $('order-customer')?.selectedOptions?.[0];
    info.innerHTML = `<span class="customer-dot"></span><section><b>${escapeHtml(option?.textContent?.split(' — ')[0] || '')}</b><small>Customer-specific prices are active.</small></section>`;
    if (manage) manage.disabled = false;
  }

  function openCustomerDialog() {
    const dialog = $('customerDialog');
    if (!dialog) return;
    $('customerForm')?.reset();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    setTimeout(() => $('customer-name')?.focus(), 50);
  }

  function closeCustomerDialog() {
    const dialog = $('customerDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  async function addCustomer(event) {
    event?.preventDefault();
    const nameInput = $('customer-name');
    const name = nameInput?.value.trim() || '';
    if (!name) { nameInput?.focus(); return; }
    try {
      const customer = await API.post('customers', {
        name, phone: $('customer-phone')?.value.trim() || '', notes: $('customer-notes')?.value.trim() || ''
      });
      closeCustomerDialog();
      db.customers = [...(db.customers || []), customer];
      await renderCustomers(db.customers);
      if (window.renderCustomerAccountsPage) window.renderCustomerAccountsPage();
      $('order-customer').value = customer.id;
      showCustomerInfo();
      await loadCustomerPrices(customer.id);
    } catch (error) {
      alert(error.message || 'Could not save customer.');
    }
  }

  function closePricesDialog() {
    const dialog = $('customerPricesDialog');
    if (dialog?.open) dialog.close();
  }

  async function openPricesDialog() {
    const customer = getSelectedCustomer();
    if (!customer) { alert(window.t('Select a customer first.')); return; }
    const dialog = $('customerPricesDialog');
    const list = $('customer-price-list');
    if (!dialog || !list) return;
    list.innerHTML = '<p class="empty">Loading prices…</p>';
    $('customer-prices-subtitle').textContent = `${customer.name} — enter a special selling price. Leave blank to use the regular price.`;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    try {
      const prices = await loadCustomerPrices(customer.id, true);
      list.innerHTML = db.products.length ? db.products.map(product => {
        const special = prices[String(product.id)];
        return `<label class="customer-price-row"><section><b>${escapeHtml(product.name)}</b><small>Regular: ${money(product.sell)}</small></section><input class="customer-price-input" data-product-id="${product.id}" type="number" min="0" step="0.01" placeholder="${Number(product.sell).toFixed(2)}" value="${special != null ? special : ''}"></label>`;
      }).join('') : '<p class="empty">No products yet.</p>';
    } catch (error) {
      list.innerHTML = `<p class="empty">Could not load prices.</p>`;
    }
  }

  async function savePrices(event) {
    event?.preventDefault();
    const customer = getSelectedCustomer();
    if (!customer) return;
    const inputs = [...document.querySelectorAll('.customer-price-input')];
    const rows = [];
    for (const input of inputs) {
      const raw = input.value.trim();
      if (raw !== '') {
        const price = Number(raw);
        if (!Number.isFinite(price) || price < 0) throw new Error('Invalid customer price.');
        rows.push({ productId: input.dataset.productId, price });
      }
    }
    try {
      const next = await API.saveCustomerPrices(customer.id, rows);
      priceCache.set(String(customer.id), next || {});
      window.customerPriceMap = next;
      activeCustomerId = String(customer.id);
      renderSelect();
      cart.forEach(item => {
        const special = next[String(item.id)];
        item.sell = Number.isFinite(Number(special)) ? Number(special) : Number(item.sellBase ?? db.products.find(p => String(p.id) === String(item.id))?.sell ?? item.sell);
      });
      renderCart();
      closePricesDialog();
    } catch (error) {
      alert(error.message || 'Could not save customer prices.');
    }
  }

  $('order-customer')?.addEventListener('change', async () => {
    showCustomerInfo();
    await loadCustomerPrices($('order-customer').value || '');
  });
  $('add-customer-from-order')?.addEventListener('click', openCustomerDialog);
  $('customerForm')?.addEventListener('submit', addCustomer);
  $('cancelCustomer')?.addEventListener('click', closeCustomerDialog);
  $('cancelCustomerX')?.addEventListener('click', closeCustomerDialog);
  $('customerDialog')?.addEventListener('click', (event) => { if (event.target === $('customerDialog')) closeCustomerDialog(); });
  $('manage-customer-prices')?.addEventListener('click', openPricesDialog);
  $('customerPricesForm')?.addEventListener('submit', savePrices);
  $('cancelCustomerPrices')?.addEventListener('click', closePricesDialog);
  $('cancelCustomerPricesX')?.addEventListener('click', closePricesDialog);
  $('customerPricesDialog')?.addEventListener('click', (event) => { if (event.target === $('customerPricesDialog')) closePricesDialog(); });

  window.getSelectedCustomerId = () => $('order-customer')?.value || '';
  window.getSelectedCustomer = () => getSelectedCustomer();
  window.renderOrderCustomers = renderCustomers;
  window.renderCustomerAccountsPage = renderCustomerAccountsPage;
  window.openCustomerDialogFromPage = openCustomerDialog;
  window.showOrderCustomerInfo = showCustomerInfo;
  window.openCustomerPricesForCustomer = async (customerId) => {
    const select = $('order-customer');
    if (select) select.value = customerId;
    showCustomerInfo();
    await loadCustomerPrices(customerId);
    openPricesDialog();
  };
  window.customerPriceMap = {};
  window.customerPriceCache = priceCache;
  renderCustomers();
})();

/* Full tri-language UI — Hebrew / English / Arabic. */
(function () {
  const T = [
    ['ניהול חנות טבק וסיגריות','Tobacco & Cigarette Shop Manager','إدارة متجر التبغ والسجائر'],
    ['חנות סיגריות','Cigarette Shop','متجر السجائر'],
    ['מערכת ניהול למנהל','Admin management system','نظام إدارة للمدير'],
    ['שם משתמש','Username','اسم المستخدم'], ['סיסמה','Password','كلمة المرور'], ['כניסה','Login','تسجيل الدخول'], ['התנתקות','Logout','تسجيل الخروج'],
    ['מנהל','Admin','المدير'], ['לוח ניהול','Admin Dashboard','لوحة تحكم المدير'], ['לוח בקרה','Dashboard','لوحة التحكم'],
    ['מלאי / מחסן','Storage / Inventory','المخزون / المستودع'], ['מלאי','Inventory','المخزون'], ['הזמנה חדשה','New Order','طلب جديد'],
    ['היסטוריית הזמנות','Order History','سجل الطلبات'], ['דוחות','Reports','التقارير'], ['תנועות מלאי','Stock Movements','حركات المخزون'], ['קבלה','Receipt','الإيصال'],
    ['טען נתוני דוגמה','Load Demo Data','تحميل بيانات تجريبية'], ['מנהל /','Admin /','المدير /'], ['שפה','Language','اللغة'],
    ['סה״כ מוצרים','Total Products','إجمالي المنتجات'], ['מוצרים פעילים','Active products','المنتجات النشطة'], ['סה״כ מלאי','Total Stock','إجمالي المخزون'], ['יחידות במלאי','Units in stock','الوحدات في المخزون'],
    ['עלות המלאי','Inventory Cost','تكلفة المخزون'], ['שווי רכישה','Purchase value','قيمة الشراء'], ['מכירות היום',"Today's Sales",'مبيعات اليوم'], ["Today's profit","Today's Profit",'ربح اليوم'],
    ['סה״כ רווח','Total Profit','إجمالي الربح'], ['כל ההזמנות שהושלמו','All completed orders','جميع الطلبات المكتملة'], ['לאחר הנחות','After discounts','بعد الخصومات'],
    ['מלאי נמוך','Low Stock','مخزون منخفض'], ['דורש טיפול','Needs attention','يحتاج إلى متابعة'],
    ['מוצרים שהמלאי שלהם ברמה המינימלית או מתחתיה','Products at or below minimum stock','منتجات عند الحد الأدنى للمخزون أو أقل'],
    ['צפה במלאי →','View Inventory →','عرض المخزون ←'], ['הזמנות אחרונות','Recent Orders','الطلبات الأخيرة'], ['המכירות האחרונות שהושלמו','Latest completed sales','أحدث المبيعات المكتملة'], ['צפה בהכול →','View All →','عرض الكل ←'],
    ['ניהול מוצרים, כמויות ומחירים.','Manage products, quantities and prices.','إدارة المنتجات والكميات والأسعار.'],
    ['ניהול מוצרים, עלויות, מחירים, מלאי והתראות על מלאי נמוך.','Manage products, costs, prices, stock and low-stock alerts.','إدارة المنتجات والتكاليف والأسعار والمخزون وتنبيهات انخفاض المخزون.'],
    ['＋ הוסף מוצר','＋ Add Product','＋ إضافة منتج'], ['+ הוספת מלאי','+ Add Stock','+ إضافة مخزون'], ['＋ הוספת מלאי','＋ Add Stock','＋ إضافة مخزون'],
    ['הוסף להזמנה','Add to Order','إضافة إلى الطلب'], ['נקה הזמנה','Clear Order','مسح الطلب'], ['יצירת מכירה והפחתת המלאי באופן אוטומטי.','Create a sale and automatically reduce stock.','إنشاء عملية بيع وخفض المخزون تلقائيًا.'],
    ['סיכום הזמנה','Order Summary','ملخص الطلب'], ['סכום ביניים','Subtotal','المجموع الفرعي'], ['הנחה','Discount','الخصم'], ['סה״כ','Total','الإجمالي'], ['עלות','Cost','التكلفة'], ['רווח','Profit','الربح'],
    ['השלם הזמנה','Complete Order','إتمام الطلب'], ['הזמנות שהושלמו והרווח שחושב.','Completed orders and calculated profit.','الطلبات المكتملة والربح المحسوب.'],
    ['חיפוש לפי מספר הזמנה…','Search by order number…','البحث حسب رقم الطلب…'], ['חיפוש לפי מוצר או מותג…','Search by product or brand…','البحث حسب المنتج أو العلامة التجارية…'], ['חיפוש מוצרים...','Search products...','البحث عن المنتجات...'],
    ['סקירת מכירות ורווחים.','Sales and profit overview.','نظرة عامة على المبيعات والأرباح.'], ['סה״כ מכירות','Total Sales','إجمالي المبيعات'], ['הזמנות','Orders','الطلبات'], ['ממוצע להזמנה','Average per Order','متوسط قيمة الطلب'],
    ['המוצרים הנמכרים ביותר','Best Selling Products','الأكثر مبيعًا'], ['יחידות שנמכרו בהזמנות שהושלמו','Units sold in completed orders','الوحدات المباعة في الطلبات المكتملة'],
    ['כל שינוי במלאי שנרשם במערכת.','Every stock change recorded in the system.','كل تغيير في المخزون مسجل في النظام.'], ['Change','Change','التغيير'], ['Reason','Reason','السبب'],
    ['הדפס קבלה','Print Receipt','طباعة الإيصال'], ['Item','Item','العنصر'], ['Qty','Qty','الكمية'], ['Selling Price','Selling Price','سعر البيع'], ['Type','Type','النوع'], ['Total Qty','Total Qty','إجمالي الكمية'], ['Totals by Type','Totals by Type','الإجماليات حسب النوع'], ['No items.','No items.','لا توجد عناصر.'], ['Thank you','Thank you','شكرًا لك'], ['Customer','Customer','العميل'], ['Order','Order','الطلب'], ['הדפסת ההזמנה האחרונה שהושלמה.','Print the last completed order.','طباعة آخر طلب مكتمل.'],
    ['מוצר','Product','المنتج'], ['שם המוצר','Product Name','اسم المنتج'], ['מותג','Brand','العلامة التجارية'], ['סוג','Type','النوع'], ['גרסה','Variant','النسخة'], ['מחיר קנייה','Purchase Cost','سعر الشراء'], ['עלות רכישה','Purchase Cost','تكلفة الشراء'], ['מחיר מכירה','Selling Price','سعر البيع'], ['כמות','Quantity','الكمية'], ['מלאי מינימלי','Minimum Stock','الحد الأدنى للمخزون'], ['ספק','Supplier','المورد'], ['פעולות','Actions','الإجراءات'], ['סטטוס','Status','الحالة'], ['שווי מלאי','Inventory Value','قيمة المخزون'], ['תאריך','Date','التاريخ'], ['פריטים','Items','العناصر'], ['הזמנה','Order','الطلب'],
    ['הוסף מוצר','Add Product','إضافة منتج'], ['שמירת מוצר','Save Product','حفظ المنتج'], ['שמירת לקוח','Save Customer','حفظ العميل'], ['ביטול','Cancel','إلغاء'], ['הוספה או עריכה של מוצר במלאי.','Add or edit a product in inventory.','إضافة أو تعديل منتج في المخزون.'],
    ['בחר סוג','Select type','اختر النوع'], ['בחר מותג','Select brand','اختر العلامة التجارية'], ['בחר מותג first','Select a brand first','اختر العلامة التجارية أولًا'], ['שם הלקוח','Customer Name','اسم العميل'], ['מספר טלפון','Phone Number','رقم الهاتف'], ['הערות','Notes','ملاحظات'], ['הערות אופציונליות על הלקוח...','Optional notes about the customer...','ملاحظات اختيارية عن العميل...'], ['הוספת לקוח','Add Customer','إضافة عميل'],
    ['לקוח','Customer','العميل'], ['לקוח להזמנה','Customer for Order','عميل الطلب'], ['למי מיועדת ההזמנה?','Who is this order for?','لمن هذا الطلب؟'], ['בחר לקוח קיים או צור לקוח חדש.','Select an existing customer or create a new one.','اختر عميلًا موجودًا أو أنشئ عميلًا جديدًا.'], ['לקוח מזדמן / ללא לקוח','Walk-in / No customer','عميل عابر / بدون عميل'], ['לא נבחר לקוח.','No customer selected.','لم يتم اختيار عميل.'], ['הזן את פרטי הלקוח.','Enter customer details.','أدخل بيانات العميل.'],
    ['אזל מהמלאי','Out of stock','نفد المخزون'], ['במלאי','In stock','متوفر في المخزون'], ['תקין','OK','سليم'], ['הוסף מוצרים תחילה.','Add products first.','أضف المنتجات أولًا.'], ['המלאי השתנה. בדוק את ההזמנה מחדש.','Stock changed. Please review the order again.','تغيّر المخزون. يرجى مراجعة الطلب مرة أخرى.'],
    ['שם המשתמש או הסיסמה שגויים.','Incorrect username or password.','اسم المستخدم أو كلمة المرور غير صحيحة.'], ['מלאי התחלתי','Initial Stock','المخزون الأولي'], ['שמירה','Save','حفظ'], ['הגדרות','Settings','الإعدادات'], ['לקוחות','Customers','العملاء'], ['ספקים','Suppliers','الموردون'], ['הוספת מלאי','Add Stock','إضافة مخزون'],
    ['💰 מחירי הלקוח','💰 Customer Prices','💰 أسعار العميل'], ['מחירי הלקוח','Customer Prices','أسعار العميل'], ['שמירת המחירים','Save Prices','حفظ الأسعار'], ['قائمة أسعار العميل','Customer Price List','قائمة أسعار العميل'],
    ['מחיר מיוחד לכל מוצר. מוצר ללא מחיר מיוחד משתמש במחיר המכירה הרגיל.','Special price for each product. Products without a special price use the regular selling price.','سعر خاص لكل منتج. المنتج بدون سعر خاص يستخدم سعر البيع العادي.'],
    ['מוצרי סיגריות','Cigarette products','منتجات السجائر'], ['ניהול חשבונות הלקוחות, الدفعات والأرصدة المستحقة.','Manage customer accounts, payments and outstanding balances.','إدارة حسابات العملاء والدفعات والأرصدة المستحقة.'],
    ['ניהול حسابات العملاء، الدפعات والأرصدة المستحقة.','Manage customer accounts, payments and outstanding balances.','إدارة حسابات العملاء والدفعات والأرصدة المستحقة.'],
    ['إجمالي المبيعات الآجلة','Total Customer Sales','إجمالي مبيعات العملاء'], ['إجمالي المدفوعات','Total Payments','إجمالي المدفوعات'], ['المبلغ المستحق','Outstanding','المبلغ المستحق'], ['كل طلبات العملاء','All customer orders','جميع طلبات العملاء'], ['الدفعات المسجلة','Recorded payments','الدفعات المسجلة'], ['أرصدة العملاء','Customer balances','أرصدة العملاء'], ['الرصيد الدائن','Credit Balance','الرصيد الدائن'],
    ['الهاتف','Phone','الهاتف'], ['إجمالي الطلبات','Orders','إجمالي الطلبات'], ['إجمالي المبيعات','Total Sales','إجمالي المبيعات'], ['المدفوع','Paid','المدفوع'], ['المستحق','Due','المستحق'], ['الإجراءات','Actions','الإجراءات'], ['الحساب','Account','الحساب'], ['＋ دفعة','＋ Payment','＋ دفعة'], ['حذف العميل','Delete Customer','حذف العميل'],
    ['حساب العميل','Customer Account','حساب العميل'], ['تسجيل دفعة','Record Payment','تسجيل دفعة'], ['المبلغ المدفوع','Payment Amount','مبلغ الدفعة'], ['ملاحظة','Note','ملاحظة'], ['مثلاً: دفعة نقدية','e.g. Cash payment','مثال: دفعة نقدية'], ['المستحق حالياً:','Current due:','المستحق حاليًا:'], ['حفظ الدفعة','Save Payment','حفظ الدفعة'], ['نشاط','Activity','النشاط'], ['إغلاق','Close','إغلاق'], ['لا يوجد عملاء.','No customers.','لا يوجد عملاء.'], ['لا يوجد نشاط على الحساب.','No account activity.','لا يوجد نشاط على الحساب.'], ['لا يوجد مبلغ مستحق على هذا العميل.','This customer has no outstanding balance.','لا يوجد مبلغ مستحق على هذا العميل.'],
    ['هل أنت متأكد من حذف','Are you sure you want to delete','هل أنت متأكد من حذف'], ['العميل','customer','العميل'], ['لا يمكن حذف عميل لديه سجل طلبات أو دفعات، حتى لا تضيع البيانات المحاسبية.','A customer with order or payment history cannot be deleted, to preserve accounting records.','لا يمكن حذف عميل لديه سجل طلبات أو دفعات، للحفاظ على السجلات المحاسبية.'],
    ['حذف الدفعة','Delete Payment','حذف الدفعة'], ['هل أنت متأكد من حذف هذه الدفعة؟','Are you sure you want to delete this payment?','هل أنت متأكد من حذف هذه الدفعة؟'], ['المبلغ:','Amount:','المبلغ:'],
    ['حذف الطلب','Delete Order','حذف الطلب'], ['هل أنت متأكد من حذف هذا الطلب؟','Are you sure you want to delete this order?','هل أنت متأكد من حذف هذا الطلب؟'],
    ['كشف حساب','Account Statement','كشف حساب'], ['🖨️ كشف حساب','🖨️ Account Statement','🖨️ كشف حساب'], ['كشف حساب العميل','Customer Account Statement','كشف حساب العميل'], ['الرصيد النهائي','Final Balance','الرصيد النهائي'], ['المبيعات','Sales','المبيعات'], ['الدفعات','Payments','الدفعات'],
    ['من تاريخ','From Date','من تاريخ'], ['إلى تاريخ','To Date','إلى تاريخ'], ['تطبيق','Apply','تطبيق'], ['اليوم','Today','اليوم'], ['هذا الشهر','This Month','هذا الشهر'], ['كل الفترات','All Time','كل الفترات'], ['الفترة الزمنية','Date Range','الفترة الزمنية'],
    ['Add Stock','Add Stock','إضافة مخزون'], ['Product','Product','المنتج'], ['Supplier','Supplier','المورد'], ['No supplier','No supplier','بدون مورد'], ['Quantity','Quantity','الكمية'], ['Purchase Cost','Purchase Cost','تكلفة الشراء'], ['Cancel','Cancel','إلغاء'], ['Save','Save','حفظ'],
    ['Cigarettes','Cigarettes','سجائر'], ['Tobacco','Tobacco','تبغ'], ['Cigars','Cigars','سيجار'], ['Rolling Tobacco','Rolling Tobacco','تبغ لف'], ['Shisha / Molasses','Shisha / Molasses','شيشة / معسل'], ['Hookah / Argileh','Hookah / Argileh','أرجيلة'], ['Accessories','Accessories','إكسسوارات'], ['Other','Other','أخرى'], ['Argileh / Hookah','Argileh / Hookah','أرجيلة / هوكا'],
    ['No orders yet.','No orders yet.','لا توجد طلبات بعد.'], ['All products are above minimum stock.','All products are above minimum stock.','جميع المنتجات فوق الحد الأدنى للمخزون.'], ['No products found.','No products found.','لم يتم العثور على منتجات.'], ['products','products','منتجات'], ['left','left','متبقي'], ['orders','orders','طلبات'],
    ['Load Demo Data','Load Demo Data','تحميل بيانات تجريبية'], ['Logout','Logout','تسجيل الخروج'], ['Language','Language','اللغة'], ['English','English','English'], ['Hebrew','Hebrew','עברית'], ['Arabic','Arabic','العربية'],
    ['Please allow pop-ups to print the statement.','Please allow pop-ups to print the statement.','يرجى السماح بالنوافذ المنبثقة لطباعة كشف الحساب.'],
    ['هذا العميل لديه رصيد دائن ولا يوجد مبلغ مستحق حالياً.','This customer has a credit balance and no amount is currently due.','هذا العميل لديه رصيد دائن ولا يوجد مبلغ مستحق حاليًا.'],
    ['لا يوجد مبلغ مستحق على هذا العميل.','This customer has no outstanding balance.','لا يوجد مبلغ مستحق على هذا العميل.'],
    ['أدخل مبلغ دفعة صحيح.','Enter a valid payment amount.','أدخل مبلغ دفعة صحيح.'],
    ['Could not record payment.','Could not record payment.','تعذر تسجيل الدفعة.'], ['Could not delete payment.','Could not delete payment.','تعذر حذف الدفعة.'], ['Could not delete customer.','Could not delete customer.','تعذر حذف العميل.'],
    ['Please select a product.','Please select a product.','يرجى اختيار منتج.'], ['Quantity must be at least 1.','Quantity must be at least 1.','يجب أن تكون الكمية 1 على الأقل.'], ['Purchase cost is invalid.','Purchase cost is invalid.','تكلفة الشراء غير صالحة.'],
    ['This product already exists. Use Add Stock instead of creating a duplicate.','This product already exists. Use Add Stock instead of creating a duplicate.','هذا المنتج موجود بالفعل. استخدم إضافة مخزون بدلًا من إنشاء نسخة مكررة.'],
    ['Could not save product.','Could not save product.','تعذر حفظ المنتج.'], ['Order deleted and stock restored.','Order deleted and stock restored.','تم حذف الطلب وإعادة الكمية إلى المخزون.'], ['Could not delete order.','Could not delete order.','تعذر حذف الطلب.'],
    ['Not enough stock.','Not enough stock.','الكمية المتوفرة في المخزون غير كافية.'], ['Discount cannot exceed subtotal.','Discount cannot exceed subtotal.','لا يمكن أن تتجاوز الخصم قيمة المجموع الفرعي.'],
    ['Demo data already exists.','Demo data already exists.','بيانات التجربة موجودة بالفعل.'], ['Could not complete order.','Could not complete order.','تعذر إتمام الطلب.'],
    ['Restore this backup? Current app data will be replaced.','Restore this backup? Current app data will be replaced.','هل تريد استعادة هذه النسخة الاحتياطية؟ سيتم استبدال بيانات التطبيق الحالية.'],
    ['Backup restored successfully.','Backup restored successfully.','تمت استعادة النسخة الاحتياطية بنجاح.'], ['Could not restore backup.','Could not restore backup.','تعذر استعادة النسخة الاحتياطية.'],
    ['Could not create backup.','Could not create backup.','تعذر إنشاء النسخة الاحتياطية.'], ['Select a customer first.','Select a customer first.','يرجى اختيار عميل أولًا.'], ['Could not save customer prices.','Could not save customer prices.','تعذر حفظ أسعار العميل.'],
    ['Delete this payment?','Delete this payment?','هل تريد حذف هذه الدفعة؟'], ['Load demo products? This only works when inventory is empty.','Load demo products? This only works when inventory is empty.','هل تريد تحميل منتجات تجريبية؟ يعمل هذا فقط عندما يكون المخزون فارغًا.'],
    ['Delete this order?','Delete this order?','هل تريد حذف هذا الطلب؟'], ['Confirmation','Confirmation','تأكيد'], ['Delete Product','Delete Product','حذف المنتج'], ['Delete this product?','Delete this product?','هل تريد حذف هذا المنتج؟'],
    ['رصيد افتتاحي','Opening Balance','رصيد افتتاحي'], ['الرصيد الافتتاحي','Opening Balance','الرصيد الافتتاحي'], ['إدخال رصيد افتتاحي','Enter Opening Balance','إدخال رصيد افتتاحي'], ['عليه مبلغ','Customer Owes','عليه مبلغ'], ['رصيد دائن','Customer Credit','رصيد دائن'], ['Enter a valid opening balance.','Enter a valid opening balance.','أدخل رصيدًا افتتاحيًا صحيحًا.'], ['Could not save opening balance.','Could not save opening balance.','تعذر حفظ الرصيد الافتتاحي.']
  ];

  const variants = new Map();
  const put = (v, langs) => { if (v != null && v !== '') variants.set(String(v), langs); };
  T.forEach(row => { const [he,en,ar] = row; put(he,row); put(en,row); put(ar,row); });

  function translateString(value, lang) {
    if (!value) return value;
    const exact = variants.get(String(value).trim());
    if (exact) return exact[lang === 'en' ? 1 : lang === 'ar' ? 2 : 0];

    let out = String(value);
    const entries = [...variants.entries()].sort((a,b)=>b[0].length-a[0].length);
    for (const [from, row] of entries) {
      if (!from || !out.includes(from)) continue;
      out = out.split(from).join(row[lang === 'en' ? 1 : lang === 'ar' ? 2 : 0]);
    }

    const n = lang === 'en' ? {
      orders: '$1 orders', products: '$1 products', left: '$1 left'
    } : lang === 'ar' ? {
      orders: '$1 طلبات', products: '$1 منتجات', left: '$1 متبقي'
    } : {
      orders: '$1 הזמנות', products: '$1 מוצרים', left: '$1 נשארו'
    };
    out = out.replace(/^(\d+)\s+(orders|طلبات|הזמנות)$/, n.orders)
             .replace(/^(\d+)\s+(products|منتجات|מוצרים)$/, n.products)
             .replace(/^(.+?)\s+(left|متبقي|נשארו)$/, n.left);
    return out;
  }

  window.t = function (value) {
    if (!value) return value;
    const row = variants.get(String(value).trim());
    if (!row) return value;
    const lang = window.currentLanguage || localStorage.getItem('cigarette_shop_language') || 'he';
    return row[lang === 'en' ? 1 : lang === 'ar' ? 2 : 0];
  };

  function applyLanguage(lang) {
    const safe = ['he','en','ar'].includes(lang) ? lang : 'he';
    document.documentElement.lang = safe;
    document.documentElement.dir = safe === 'he' || safe === 'ar' ? 'rtl' : 'ltr';
    document.title = safe === 'en' ? 'Tobacco & Cigarette Shop Manager' : safe === 'ar' ? 'إدارة متجر التبغ والسجائر' : 'ניהול חנות טבק וסיגריות';

    document.querySelectorAll('input, textarea, select, [aria-label]').forEach(el => {
      if (el.placeholder) el.placeholder = translateString(el.placeholder, safe);
      if (el.getAttribute('aria-label')) el.setAttribute('aria-label', translateString(el.getAttribute('aria-label'), safe));
    });

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes=[];
    while(walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      if (node.parentElement && ['SCRIPT','STYLE'].includes(node.parentElement.tagName)) return;
      const raw=node.nodeValue;
      const trimmed=raw.trim();
      if (!trimmed) return;
      const translated=translateString(trimmed,safe);
      if (translated !== trimmed) node.nodeValue=raw.replace(trimmed,translated);
    });

    document.querySelectorAll('option').forEach(o => {
      const text=o.textContent.trim();
      if (text) o.textContent=translateString(text,safe);
    });

    const sel=document.getElementById('language-select');
    if(sel) sel.value=safe;
    localStorage.setItem('cigarette_shop_language',safe);
    window.currentLanguage=safe;
  }

  window.fullTranslate = applyLanguage;
  window.applyLanguage = applyLanguage;
  document.getElementById('language-select')?.addEventListener('change', e => applyLanguage(e.target.value));

  const originalRender = window.render;
  if (typeof originalRender === 'function') {
    window.render = function () {
      const result = originalRender.apply(this, arguments);
      applyLanguage(localStorage.getItem('cigarette_shop_language') || 'he');
      return result;
    };
  }

  applyLanguage(localStorage.getItem('cigarette_shop_language') || 'he');
})();
