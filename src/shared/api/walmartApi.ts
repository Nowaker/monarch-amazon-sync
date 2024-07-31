import { CheerioAPI, load } from 'cheerio';
import * as Throttle from 'promise-parallel-throttle';
import { debugLog } from '../storages/debugStorage';
import { AuthStatus } from '../storages/appStorage';
import { Order, Item, OrderTransaction } from '../types';
import { Provider } from './providerApi';
import { ProgressPhase, ProgressState } from '../storages/progressStorage';

const ORDER_PAGES_URL = 'https://www.walmart.com/orders';
const ORDER_DETAILS_URL = 'https://www.walmart.com/orders/{orderID}?storePurchase={storePurchase}';

export class WalmartProvider extends Provider {
  name = 'Walmart';
  lastUpdatedKey = 'lastWalmartAuth';
  statusKey = 'walmartStatus';

  protected async doCheckAuth(): Promise<{ status: AuthStatus; startingYear?: number }> {
    try {
      const res = await fetch(ORDER_PAGES_URL);
      const text = await res.text();
      const $ = load(text);

      const signIn = $('.mw3:contains("Sign In")');

      if (signIn.length > 0) {
        return { status: AuthStatus.NotLoggedIn };
      }

      const yearOptions: string[] = [];
      $('#time-filter')
        .find('option')
        .each((_, el) => {
          if ($(el).attr('value')?.includes('year')) {
            yearOptions.push(el.attribs.value?.trim().replace('year-', ''));
          }
        });
      const lowestYear = Math.min(...yearOptions.map(x => parseInt(x)));

      return { status: AuthStatus.Success, startingYear: lowestYear };
    } catch (e) {
      await debugLog(`Walmart auth failed with error: ${e}`);
      return { status: AuthStatus.Failure };
    }
  }

  async fetchOrders(year: number | undefined, maxPages: number | undefined, onProgress: (progress: ProgressState) => void): Promise<Order[]> {
    let url = ORDER_PAGES_URL;
    if (year) {
      url += `?timeFilter=year-${year}`;
    }
    const res = await fetch(url);
    const text = await res.text();
    const $ = load(text);

    let endPage = 1;
    if (maxPages && maxPages < endPage) {
      endPage = maxPages;
    }

    onProgress({ phase: ProgressPhase.WalmartPageScan, total: endPage, complete: 0 });

    let orders = this.orderListFromPage($);

    onProgress({ phase: ProgressPhase.WalmartPageScan, total: endPage, complete: 1 });

    for (let i = 2; i <= endPage; i++) {
      const ordersPage = await this.processOrders(year, i);
      orders = orders.concat(ordersPage);
      onProgress({ phase: ProgressPhase.WalmartPageScan, total: endPage, complete: i });
    }

    const allOrders: Order[] = [];

    const processOrder = async (order: Order) => {
      try {
        const orderData = await this.fetchOrderTransactions(order);
        if (orderData) {
          allOrders.push(orderData);
        }
      } catch (e: unknown) {
        await debugLog(e);
      }

      onProgress({ phase: ProgressPhase.WalmartOrderDownload, total: orders.length, complete: allOrders.length });
    };

    await Throttle.all(orders.map(order => () => processOrder(order)));

    return allOrders;
  }

  async processOrders(year: number | undefined, page: number): Promise<Order[]> {
    const index = (page - 1) * 10;
    let url = ORDER_PAGES_URL + '?startIndex=' + index;
    if (year) {
      url += `&timeFilter=year-${year}`;
    }
    const res = await fetch(url);
    const text = await res.text();
    const $ = load(text);
    return this.orderListFromPage($);
  }

  orderListFromPage($: CheerioAPI): Order[] {
    const orders: Order[] = [];

    $('[data-testid^="orderGroup-"]').each((_, el) => {
      try {
        const returnLink = $(el).find('a[link-identifier="Start a return"]')?.attr('href');
        const id = returnLink?.replace(/.*orders\/([^/]+)\/.*/, '$1');
        const walmartStorePurchase = returnLink?.includes('orderSource=STORE');

        if (!id) {
          debugLog('No order ID found in orderGroup-* element');
          return;
        }

        const dateText = $(el).find('h3').text().trim();
        const dateMatch = dateText.match(/(\w+ \d{2}, \d{4}) purchase/);
        const date = dateMatch ? dateMatch[1] : '';

        orders.push({
          // provider: Provider.Walmart,
          id,
          date,
          walmartStorePurchase,
        });
      } catch (e: unknown) {
        debugLog(e);
      }
    });

    return orders;
  }

  async fetchOrderTransactions(order: Order): Promise<Order> {
    const orderUrl = ORDER_DETAILS_URL.replace('{orderID}', order.id).replace(
      '{storePurchase}',
      order.walmartStorePurchase ? 'true' : 'false',
    );

    const res = await fetch(orderUrl);
    const text = await res.text();
    const $ = load(text);

    const items: Item[] = [];

    $('[data-testid="itemtile-stack"]').each((_, el) => {
      const itemTitle = $(el).find('[data-testid="productName"]').first()?.text()?.trim();
      const itemPriceText = $(el).find('.column3 .f5.b.black.tr').first()?.text()?.trim();
      const itemPrice = itemPriceText ? parseFloat(itemPriceText.replace(/[^0-9.-]+/g, '')) : 0;
      const isRefunded = $(el)
        .closest('[data-testid^="category-accordion"]')
        .find('[data-testid="category-label"]')
        .text()
        .includes('Refunded');

      if (itemTitle) {
        items.push({
          // provider: Provider.Walmart,
          orderId: order.id,
          title: itemTitle,
          price: itemPrice,
          refunded: isRefunded,
        });
      }
    });

    const transactions: OrderTransaction[] = [];

    $('[data-testid^="orderGroup-"], .print-bill-body').each((_, el) => {
      const dateText = $(el).find('h1.print-bill-date').text().trim();
      const dateMatch = dateText.match(/(\w+ \d{2}, \d{4}) (order|purchase)/);
      const date = dateMatch ? dateMatch[1] : '';

      const amountText = $(el).find('.bill-order-total-payment h2').last().text().trim();
      const amount = amountText ? parseFloat(amountText.replace(/[^0-9.-]+/g, '')) : 0;

      const refund = $(el).find('[data-testid="category-label"]').text().includes('Refunded');

      transactions.push({
        // provider: Provider.Walmart,
        id: order.id,
        date,
        amount,
        refund,
        items: items.filter(item => item.refunded === refund),
      });
    });

    return {
      ...order,
      transactions,
    };
  }
}
