import { ProgressPhase, ProgressState } from '../storages/progressStorage';
import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import * as Throttle from 'promise-parallel-throttle';
import { debugLog } from '../storages/debugStorage';
import { AuthStatus } from '../storages/appStorage';

const ORDER_PAGES_URL = 'https://www.amazon.com/gp/css/order-history?disableCsd=no-js';
const ORDER_DETAILS_URL = 'https://www.amazon.com/gp/your-account/order-details';

export type AmazonInfo = {
  status: AuthStatus;
  startingYear?: number;
};

export type Order = {
  id: string;
  date: string;
  transactions?: OrderTransaction[];
};

export type Item = {
  title: string;
  price: number;
};

export type OrderTransaction = {
  id: string;
  amount: number;
  date: string;
  refund: boolean;
  items: Item[];
};

export async function checkAmazonAuth(): Promise<AmazonInfo> {
  try {
    debugLog('Checking Amazon auth');
    const res = await fetch(ORDER_PAGES_URL);
    await debugLog('Got Amazon auth response' + res.status);
    const text = await res.text();
    const $ = load(text);

    const signIn = $('h1:contains("Sign in")');

    if (signIn.length > 0) {
      await debugLog('Amazon auth failed');
      return {
        status: AuthStatus.NotLoggedIn,
      };
    }

    const yearOptions: string[] = [];
    $('#time-filter')
      .find('option')
      .each((_, el) => {
        if ($(el).attr('value')?.includes('year')) {
          yearOptions.push(el.attribs.value?.trim().replace('year-', ''));
        }
      });
    // find the lowest year
    const lowestYear = Math.min(...yearOptions.map(x => parseInt(x)));

    await debugLog('Amazon auth success');
    return {
      status: AuthStatus.Success,
      startingYear: lowestYear,
    };
  } catch (e) {
    await debugLog('Amazon auth failed with error: ' + e);
    return {
      status: AuthStatus.Failure,
    };
  }
}

export async function fetchOrders(
  year: number | undefined,
  onProgress: (progress: ProgressState) => void,
): Promise<Order[]> {
  let url = ORDER_PAGES_URL;
  if (year) {
    url += `&timeFilter=year-${year}`;
  }
  await debugLog('Fetching orders from ' + url);
  const res = await fetch(url);
  await debugLog('Got orders response ' + res.status);
  const text = await res.text();
  const $ = load(text);

  let endPage = 1;
  $('.a-pagination li').each((_, el) => {
    const page = $(el).text().trim();
    if (!Number.isNaN(page)) {
      const numPage = parseInt(page);
      if (numPage > endPage) {
        endPage = numPage;
      }
    }
  });

  onProgress({ phase: ProgressPhase.AmazonPageScan, total: endPage, complete: 0 });

  let orders = orderListFromPage($);
  await debugLog('Found ' + orders.length + ' orders');

  onProgress({ phase: ProgressPhase.AmazonPageScan, total: endPage, complete: 1 });

  for (let i = 2; i <= endPage; i++) {
    const ordersPage = await processOrders(year, i);
    orders = orders.concat(ordersPage);
    onProgress({ phase: ProgressPhase.AmazonPageScan, total: endPage, complete: i });
  }

  const allOrders: Order[] = [];

  const processOrder = async (order: Order) => {
    try {
      const orderData = await fetchOrderTransactions(order);
      if (orderData) {
        allOrders.push(orderData);
      }
    } catch (e: unknown) {
      await debugLog(e);
    }

    onProgress({ phase: ProgressPhase.AmazonOrderDownload, total: orders.length, complete: allOrders.length });
  };

  await Throttle.all(orders.map(order => () => processOrder(order)));

  return allOrders;
}

async function processOrders(year: number | undefined, page: number) {
  const index = (page - 1) * 10;
  let url = ORDER_PAGES_URL + '&startIndex=' + index;
  if (year) {
    url += `&timeFilter=year-${year}`;
  }
  await debugLog('Fetching orders from ' + url);
  const res = await fetch(url);
  await debugLog('Got orders response ' + res.status + ' for page ' + page);
  const text = await res.text();
  const $ = load(text);
  return orderListFromPage($);
}

function orderListFromPage($: CheerioAPI): Order[] {
  const orders: Order[] = [];
  $('.js-order-card').each((_, el) => {
    try {
      const id = $(el)
        .find('a[href*="orderID="]')
        ?.attr('href')
        ?.replace(/.*orderID=([^&#]+).*/, '$1');
      if (id) {
        const date = $(el).find('.order-info .value')?.first().text().trim();
        orders.push({
          id,
          date,
        });
      }
    } catch (e: unknown) {
      debugLog(e);
    }
  });
  return orders;
}

async function fetchOrderTransactions(order: Order): Promise<Order> {
  await debugLog('Fetching order ' + order.id);
  const res = await fetch(ORDER_DETAILS_URL + '?orderID=' + order.id);
  await debugLog('Got order response ' + res.status + ' for order ' + order.id);
  const text = await res.text();
  const $ = load(text);

  const items: Item[] = [];
  $('.yohtmlc-item').each((_, el) => {
    const item = $(el).find('.a-link-normal').first()?.text()?.trim();
    const price = moneyToNumber($(el).find('.a-color-price').first()?.text());
    if (item) {
      items.push({
        title: item,
        price,
      });
    }
  });

  const transactions: OrderTransaction[] = [];

  const giftCardAmount = moneyToNumber($('#od-subtotals .a-column:contains("Gift Card") + .a-column').text());
  if (giftCardAmount) {
    transactions.push({
      id: order.id,
      date: order.date,
      amount: giftCardAmount,
      refund: false,
      items,
    });
  }

  const fullDetails = $('.a-expander-inline-content ').first();
  $(fullDetails)
    .find('.a-row')
    .each((_, el) => {
      const line = $(el).text().trim().replaceAll('\n', '');
      if (line.includes('Items shipped')) {
        const dateAndAmount = line.split('shipped:')[1].trim();
        const date = dateAndAmount.split('-')[0].trim();
        const amount = moneyToNumber(dateAndAmount.split('-')[1].split('$')[1]);
        transactions.push({
          id: order.id,
          date,
          amount,
          refund: false,
          items,
        });
      } else if (line.includes('Refund: Completed')) {
        const dateAndAmount = line.split(': Completed')[1].trim();
        const date = dateAndAmount.split('-')[0].trim();
        const amount = moneyToNumber(dateAndAmount.split('-')[1].split('$')[1]);
        transactions.push({
          id: order.id,
          date,
          amount,
          refund: true,
          items,
        });
      }
    });

  return {
    ...order,
    transactions,
  };
}

function moneyToNumber(money: string, absoluteValue = true) {
  return parseFloat(money?.replace(absoluteValue ? /[$\s-]/g : /[$\s]/g, ''));
}
