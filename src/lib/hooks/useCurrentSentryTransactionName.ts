import type {StartSpanOptions} from '@sentry/core';
import {useState, useEffect, useCallback, useSyncExternalStore} from 'react';
import {useConfigContext} from 'toolbar/context/ConfigContext';
import readSentryClientAndScope from 'toolbar/hooks/useSentryClientAndScope';

export default function useCurrentSentryTransactionName() {
  const [{transactionToSearchTerm}] = useConfigContext();
  // This helper is a plain host-carrier lookup, without React hooks.
  const {scope, client} = readSentryClientAndScope();

  const [transaction, setTransaction] = useState(() => ({
    scope,
    client,
    name: scope?.getScopeData().transactionName || '',
  }));

  if (transaction.scope !== scope || transaction.client !== client) {
    setTransaction({scope, client, name: scope?.getScopeData().transactionName || ''});
  }

  useEffect(() => {
    return client?.on('startNavigationSpan', (options: StartSpanOptions) => {
      setTransaction({scope, client, name: options.name || ''});
    });
  }, [client, scope]);

  const hasTransactionName = Boolean(transaction.name);
  const subscribeToHost = useCallback(
    (onStoreChange: () => void) => {
      // Discover SDK lifecycle changes even when its transaction name wins.
      // The same observer samples pathname only while a fallback is needed.
      const interval = window.setInterval(() => {
        const current = readSentryClientAndScope();
        if (current.scope !== scope || current.client !== client) {
          setTransaction({...current, name: current.scope?.getScopeData().transactionName || ''});
        }
        if (!hasTransactionName) {
          onStoreChange();
        }
      }, 500);
      return () => window.clearInterval(interval);
    },
    [scope, client, hasTransactionName]
  );
  const getPathname = useCallback(() => (hasTransactionName ? '' : window.location.pathname), [hasTransactionName]);
  const pathname = useSyncExternalStore(subscribeToHost, getPathname);

  return transactionToSearchTerm(transaction.name || pathname);
}
