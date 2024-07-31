import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ToggleSwitch } from 'flowbite-react';
import progressStorage, { ProgressPhase } from '@root/src/shared/storages/progressStorage';
import useStorage from '@root/src/shared/hooks/useStorage';
import { checkAuth as checkAmazonAuth } from '@root/src/shared/api/amazonApi';
import { checkAuth as checkCostcoAuth } from '@root/src/shared/api/costcoApi';
import { checkAuth as checkWalmartAuth } from '@root/src/shared/api/walmartApi';
import appStorage, { AuthStatus } from '@root/src/shared/storages/appStorage';
import ProgressIndicator from './components/ProgressIndicator';
import withErrorBoundary from '@root/src/shared/hoc/withErrorBoundary';
import withSuspense from '@root/src/shared/hoc/withSuspense';
import ConnectionInfo, { ConnectionStatus } from './components/ConnectionInfo';
import { useAlarm } from '@root/src/shared/hooks/useAlarm';
import { Action } from '@root/src/shared/types';


const Main = () => {
  const progress = useStorage(progressStorage);
  const appData = useStorage(appStorage);
  const syncAlarm = useAlarm('sync-alarm');

  const providers = [
    new Provider(
      'Amazon connection',
      appData.lastAmazonAuth,
      appData.amazonStatus,
      checkAmazonAuth,
      (status, lastAuth, startingYear) => appStorage.patch({
        amazonStatus: status,
        lastAmazonAuth: lastAuth,
        oldestAmazonYear: startingYear
      }),
      {
        notLoggedIn: 'Log in to Amazon and try again.',
        failure: 'Failed to connect to Amazon. Ensure the extension has been granted access.'
      }
    ),
    new Provider(
      'Costco connection',
      appData.lastCostcoAuth,
      appData.costcoStatus,
      checkCostcoAuth,
      (status, lastAuth, startingYear) => appStorage.patch({
        costcoStatus: status,
        lastCostcoAuth: lastAuth,
        oldestCostcoYear: startingYear
      }),
      {
        notLoggedIn: 'Log in to Costco and try again.',
        failure: 'Failed to connect to Costco. Ensure the extension has been granted access.'
      }
    ),
    new Provider(
      'Walmart connection',
      appData.lastWalmartAuth,
      appData.walmartStatus,
      checkWalmartAuth,
      (status, lastAuth, startingYear) => appStorage.patch({
        walmartStatus: status,
        lastWalmartAuth: lastAuth,
        oldestWalmartYear: startingYear
      }),
      {
        notLoggedIn: 'Log in to Walmart and try again.',
        failure: 'Failed to connect to Walmart. Ensure the extension has been granted access.'
      }
    )
  ];

  const actionOngoing = useMemo(
    () => progress.phase !== ProgressPhase.Complete && progress.phase !== ProgressPhase.Idle,
    [progress],
  );

  useEffect(() => {
    if (actionOngoing) {
      const originalComplete = progress.complete;
      const originalPhase = progress.phase;
      const timeoutId = setTimeout(async () => {
        const { complete, phase } = await progressStorage.get();
        if (complete === originalComplete && phase == originalPhase) {
          await progressStorage.patch({
            phase: ProgressPhase.Complete,
          });
        }
      }, 15_000);

      return () => clearTimeout(timeoutId);
    }
  }, [actionOngoing, progress.complete, progress.phase]);

  const [checkedProviders, setCheckedProviders] = useState<Record<string, boolean>>({});

  useEffect(() => {
    providers.forEach(provider => {
      if (
        (provider.status === AuthStatus.Success &&
          new Date(provider.lastUpdated).getTime() > Date.now() - 1000 * 60 * 60 * 24) ||
        checkedProviders[provider.name]
      ) {
        return;
      }
      setCheckedProviders(prev => ({ ...prev, [provider.name]: true }));
      appStorage.patch({ [`${provider.name.toLowerCase().split(' ')[0]}Status`]: AuthStatus.Pending }).then(() => {
        provider.checkAuth().then(response => {
          if (response.status === AuthStatus.Success) {
            provider.updateStatus(AuthStatus.Success, Date.now(), response.startingYear);
          } else {
            provider.updateStatus(response.status, Date.now());
          }
        });
      });
    });
  }, [checkedProviders, providers]);

  const ready = providers.every(provider => provider.status === AuthStatus.Success) && !actionOngoing;

  const forceSync = useCallback(async () => {
    if (!ready) return;

    await chrome.runtime.sendMessage({ action: Action.FullSync });
  }, [ready]);

  return (
    <div className="flex flex-col flex-grow">
      <div className="ml-2">
        {providers.map(provider => (
          <ConnectionInfo
            key={provider.name}
            name={provider.name}
            lastUpdated={provider.lastUpdated}
            status={
              provider.status === AuthStatus.Pending
                ? ConnectionStatus.Loading
                : provider.status === AuthStatus.Success
                  ? ConnectionStatus.Success
                  : ConnectionStatus.Error
            }
            message={
              provider.status === AuthStatus.NotLoggedIn
                ? provider.statusMessages.notLoggedIn
                : provider.status === AuthStatus.Failure
                  ? provider.statusMessages.failure
                  : undefined
            }
          />
        ))}
      </div>

      <div className="flex flex-col flex-grow items-center justify-center">
        <ProgressIndicator progress={progress} />
      </div>

      <div className="flex flex-row m-3 items-center">
        <div className="flex flex-col">
          <ToggleSwitch
            checked={appData.options.syncEnabled}
            label="Sync enabled"
            onChange={value => {
              appStorage.patch({ options: { ...appData.options, syncEnabled: value } });
            }}
          />
          <span className="text-gray-500 text-xs font-normal">
            When enabled, sync will run automatically every 24 hours.
          </span>
          {appData.options.syncEnabled && (
            <span className="text-xs font-normal">
              Next sync: {syncAlarm ? new Date(syncAlarm.scheduledTime).toLocaleTimeString() : '...'}
            </span>
          )}
        </div>
        <Button color="cyan" disabled={!ready} onClick={forceSync}>
          Force sync
        </Button>
      </div>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Main, <div> Loading ... </div>), <div> Error Occur </div>);
