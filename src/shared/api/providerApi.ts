import { AuthStatus } from '../storages/appStorage';
import { Order } from '../types';
import appStorage from '../storages/appStorage';
import { debugLog } from '../storages/debugStorage';
import { ProgressState } from '../storages/progressStorage';

export abstract class Provider {
  abstract name: string;
  abstract lastUpdatedKey: string;
  abstract statusKey: string;
  abstract fetchOrders(year: number | undefined, maxPages: number | undefined, onProgress: (progress: ProgressState) => void): Promise<Order[]>;
  abstract fetchOrderTransactions(order: Order): Promise<Order>;

  constructor() {
  }

  async settingsStore(): Promise<void> {
    const appData = await appStorage.get();
    appData.providerData[this.constructor.name] = {}
  }

  async checkAuth(): Promise<void> {
    await debugLog(`Checking ${this.name} auth`);
    const { status, startingYear } = await this.doCheckAuth();
    if (status === AuthStatus.Success) {
      await appStorage.patch({
        [this.statusKey]: AuthStatus.Success,
        [this.lastUpdatedKey]: Date.now(),
        [`${this.name.toLowerCase()}StartingYear`]: startingYear,
      });
    } else {
      await appStorage.patch({ [this.statusKey]: status });
    }
  }

  protected abstract doCheckAuth(): Promise<{ status: AuthStatus; startingYear?: number }>;

  getStatus(): AuthStatus {
    return appStorage.get(this.statusKey) as AuthStatus;
  }

  getLastUpdated(): number {
    return appStorage.get(this.lastUpdatedKey) as number;
  }

  getStatusMessage(): { notLoggedIn: string; failure: string } {
    return {
      notLoggedIn: `Log in to ${this.name} and try again.`,
      failure: `Failed to connect to ${this.name}. Ensure the extension has been granted access.`,
    };
  }
}
