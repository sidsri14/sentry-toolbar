import type {Scope} from '@sentry/core';
import type {Client, StartSpanOptions} from '@sentry/core';
import {Scope as SentryScope} from '@sentry/core';
import {act, cleanup, renderHook} from '@testing-library/react';
import type {PropsWithChildren} from 'react';
import {createElement, StrictMode} from 'react';
import {jsx} from 'react/jsx-runtime';
import {StaticConfigProvider} from 'toolbar/context/ConfigContext';
import defaultConfig from 'toolbar/context/defaultConfig';
import useCurrentSentryTransactionName from 'toolbar/hooks/useCurrentSentryTransactionName';
import useSentryClientAndScope from 'toolbar/hooks/useSentryClientAndScope';

jest.mock('toolbar/hooks/useSentryClientAndScope');

const mockUseSentryClientAndScope = jest.mocked(useSentryClientAndScope);
const readSentryClientAndScope = jest.requireActual<{default: typeof useSentryClientAndScope}>(
  'toolbar/hooks/useSentryClientAndScope'
).default;

function createSDK(transactionName: string) {
  const scope = new SentryScope().setTransactionName(transactionName);
  const listeners = new Set<(options: StartSpanOptions) => void>();
  const client = {
    on(event: string, listener: (options: StartSpanOptions) => void) {
      if (event === 'startNavigationSpan') {
        listeners.add(listener);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as Client;
  return {
    scope,
    client,
    listeners,
    navigate(name: string) {
      listeners.forEach(listener => listener({name}));
    },
  };
}

function advanceTime(milliseconds = 500) {
  act(() => {
    jest.advanceTimersByTime(milliseconds);
  });
}

function installSDK(sdk: ReturnType<typeof createSDK>) {
  sdk.scope.setClient(sdk.client);
  Object.defineProperty(window, '__SENTRY__', {
    configurable: true,
    writable: true,
    value: {version: 'test', test: {stack: {getScope: () => sdk.scope}}},
  });
}

describe('useCurrentSentryTransactionName', () => {
  const originalLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const originalCarrier = Object.getOwnPropertyDescriptor(window, '__SENTRY__');

  beforeEach(() => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/projects/123/issues');
    mockUseSentryClientAndScope.mockReturnValue({scope: undefined, client: undefined});
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
    window.history.replaceState({}, '', originalLocation);
    if (originalCarrier) {
      Object.defineProperty(window, '__SENTRY__', originalCarrier);
    } else {
      Reflect.deleteProperty(window, '__SENTRY__');
    }
    jest.clearAllMocks();
  });

  it('uses the current pathname when the Sentry SDK is unavailable', () => {
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    expect(result.current).toBe('/projects/*/issues');
  });

  it('prefers the current Sentry transaction name', () => {
    const scope = {
      getScopeData: () => ({transactionName: '/organizations/456/settings'}),
    } as unknown as Scope;
    mockUseSentryClientAndScope.mockReturnValue({scope, client: undefined});

    const {result} = renderHook(() => useCurrentSentryTransactionName());

    expect(result.current).toBe('/organizations/*/settings');
  });

  it('uses the current pathname when the Sentry transaction name is empty', () => {
    const scope = {
      getScopeData: () => ({transactionName: ''}),
    } as unknown as Scope;
    mockUseSentryClientAndScope.mockReturnValue({scope, client: undefined});

    const {result} = renderHook(() => useCurrentSentryTransactionName());

    expect(result.current).toBe('/projects/*/issues');
  });

  it.each([undefined, ''])('tracks consecutive host navigations with SDK name %s', transactionName => {
    const scope = transactionName === undefined ? undefined : new SentryScope().setTransactionName(transactionName);
    mockUseSentryClientAndScope.mockReturnValue({scope, client: undefined});
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    window.history.pushState({}, '', '/teams/456/settings');
    advanceTime(499);
    expect(result.current).toBe('/projects/*/issues');
    advanceTime(1);
    expect(result.current).toBe('/teams/*/settings');

    window.history.replaceState({}, '', '/accounts/789/security');
    advanceTime();
    expect(result.current).toBe('/accounts/*/security');
  });

  it('tracks a pathname restored by history traversal', () => {
    window.history.replaceState({}, '', '/teams/456/settings');
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    window.history.replaceState({}, '', '/projects/123/issues');
    window.dispatchEvent(new PopStateEvent('popstate'));
    advanceTime();

    expect(result.current).toBe('/projects/*/issues');
  });

  it('keeps the pathname filter when only the query and hash change', () => {
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    window.history.pushState({}, '', '/projects/123/issues?sort=last_seen#details');
    advanceTime();

    expect(result.current).toBe('/projects/*/issues');
  });

  it('preserves a nonempty SDK transaction name while observing SDK identity', () => {
    const sdk = createSDK('/organizations/:orgId/settings');
    mockUseSentryClientAndScope.mockReturnValue(sdk);
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    window.history.pushState({}, '', '/teams/456/settings');
    advanceTime(1000);

    expect(result.current).toBe('/organizations/*/settings');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('stops fallback polling when an SDK navigation name arrives', () => {
    const sdk = createSDK('');
    mockUseSentryClientAndScope.mockReturnValue(sdk);
    const {result} = renderHook(() => useCurrentSentryTransactionName());
    expect(jest.getTimerCount()).toBe(1);

    act(() => sdk.navigate('/organizations/:orgId/settings'));
    window.history.pushState({}, '', '/teams/456/settings');
    advanceTime(1000);

    expect(result.current).toBe('/organizations/*/settings');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('discovers a newly installed SDK without a pathname change or forced render', () => {
    Reflect.deleteProperty(window, '__SENTRY__');
    mockUseSentryClientAndScope.mockImplementation(readSentryClientAndScope);
    const {result} = renderHook(() => useCurrentSentryTransactionName());
    const sdk = createSDK('/organizations/:orgId/settings');

    installSDK(sdk);
    advanceTime(499);
    expect(result.current).toBe('/projects/*/issues');
    advanceTime(1);

    expect(result.current).toBe('/organizations/*/settings');
    expect(sdk.listeners.size).toBe(1);
  });

  it('discovers a replacement scope on the same host client without a forced render', () => {
    const sdk = createSDK('/organizations/:orgId/settings');
    installSDK(sdk);
    mockUseSentryClientAndScope.mockImplementation(readSentryClientAndScope);
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    sdk.scope = new SentryScope().setTransactionName('/teams/:teamId/settings');
    sdk.scope.setClient(sdk.client);
    advanceTime();

    expect(result.current).toBe('/teams/*/settings');
    expect(sdk.listeners.size).toBe(1);
  });

  it('discovers a replacement client on the same host scope without a forced render', () => {
    const previous = createSDK('/organizations/:orgId/settings');
    const next = createSDK('');
    installSDK(previous);
    mockUseSentryClientAndScope.mockImplementation(readSentryClientAndScope);
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    previous.scope.setClient(next.client);
    advanceTime();
    act(() => next.navigate('/teams/:teamId/settings'));
    act(() => previous.navigate('/stale/sdk/route'));

    expect(result.current).toBe('/teams/*/settings');
    expect(previous.listeners.size).toBe(0);
    expect(next.listeners.size).toBe(1);
  });

  it('discovers SDK removal and resumes pathname tracking without a forced render', () => {
    const sdk = createSDK('/organizations/:orgId/settings');
    installSDK(sdk);
    mockUseSentryClientAndScope.mockImplementation(readSentryClientAndScope);
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    Reflect.deleteProperty(window, '__SENTRY__');
    window.history.pushState({}, '', '/teams/456/settings');
    advanceTime(499);
    expect(result.current).toBe('/organizations/*/settings');
    advanceTime(1);
    expect(result.current).toBe('/teams/*/settings');
    expect(sdk.listeners.size).toBe(0);

    act(() => sdk.navigate('/stale/sdk/route'));
    window.history.replaceState({}, '', '/accounts/789/security');
    advanceTime();
    expect(result.current).toBe('/accounts/*/security');
  });

  it.each(['', '/organizations/:orgId/settings'])('does not rerender unchanged host state with SDK name %s', name => {
    const sdk = createSDK(name);
    installSDK(sdk);
    mockUseSentryClientAndScope.mockImplementation(readSentryClientAndScope);
    let renders = 0;
    renderHook(() => {
      renders++;
      return useCurrentSentryTransactionName();
    });
    const initialRenders = renders;

    advanceTime(2000);

    expect(renders).toBe(initialRenders);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('resumes the current pathname fallback after an empty SDK navigation name', () => {
    const sdk = createSDK('/organizations/:orgId/settings');
    mockUseSentryClientAndScope.mockReturnValue(sdk);
    const {result} = renderHook(() => useCurrentSentryTransactionName());

    window.history.pushState({}, '', '/teams/456/settings');
    act(() => sdk.navigate(''));
    expect(result.current).toBe('/teams/*/settings');

    window.history.replaceState({}, '', '/accounts/789/security');
    advanceTime();
    expect(result.current).toBe('/accounts/*/security');
  });

  it('synchronizes a replacement scope on the same client', () => {
    const sdk = createSDK('/organizations/:orgId/settings');
    mockUseSentryClientAndScope.mockReturnValue(sdk);
    const {result, rerender} = renderHook(() => useCurrentSentryTransactionName());
    const scope = new SentryScope().setTransactionName('/teams/:teamId/settings');

    mockUseSentryClientAndScope.mockReturnValue({scope, client: sdk.client});
    rerender();

    expect(result.current).toBe('/teams/*/settings');
    expect(sdk.listeners.size).toBe(1);
  });

  it('synchronizes a replacement client and unsubscribes the previous one', () => {
    const previous = createSDK('/organizations/:orgId/settings');
    mockUseSentryClientAndScope.mockReturnValue(previous);
    const {result, rerender} = renderHook(() => useCurrentSentryTransactionName());
    const next = createSDK('/teams/:teamId/settings');

    mockUseSentryClientAndScope.mockReturnValue(next);
    rerender();
    act(() => previous.navigate('/stale/sdk/route'));

    expect(result.current).toBe('/teams/*/settings');
    expect(previous.listeners.size).toBe(0);
    expect(next.listeners.size).toBe(1);
  });

  it('returns to pathname tracking when the SDK is removed', () => {
    const sdk = createSDK('/organizations/:orgId/settings');
    mockUseSentryClientAndScope.mockReturnValue(sdk);
    const {result, rerender} = renderHook(() => useCurrentSentryTransactionName());

    window.history.pushState({}, '', '/teams/456/settings');
    mockUseSentryClientAndScope.mockReturnValue({scope: undefined, client: undefined});
    rerender();
    act(() => sdk.navigate('/stale/sdk/route'));
    expect(result.current).toBe('/teams/*/settings');

    window.history.replaceState({}, '', '/accounts/789/security');
    advanceTime();
    expect(result.current).toBe('/accounts/*/security');
    expect(sdk.listeners.size).toBe(0);
  });

  it('applies the configured normalizer to pathname and SDK names', () => {
    function wrapper({children}: PropsWithChildren) {
      return jsx(StaticConfigProvider, {
        config: {...defaultConfig, transactionToSearchTerm: (name: string) => `custom:${name}`},
        children,
      });
    }
    const {result, rerender} = renderHook(() => useCurrentSentryTransactionName(), {wrapper});
    expect(result.current).toBe('custom:/projects/123/issues');

    window.history.pushState({}, '', '/teams/456/settings');
    advanceTime();
    expect(result.current).toBe('custom:/teams/456/settings');

    mockUseSentryClientAndScope.mockReturnValue(createSDK('/accounts/:id/security'));
    rerender();
    expect(result.current).toBe('custom:/accounts/:id/security');
  });

  it.each([
    ['', '/teams/*/settings'],
    ['/organizations/:orgId/settings', '/organizations/*/settings'],
  ])('cleans up independent StrictMode consumers with SDK name %s without wrapping host history', (name, expected) => {
    const sdk = createSDK(name);
    mockUseSentryClientAndScope.mockReturnValue(sdk);
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    function wrapper({children}: PropsWithChildren) {
      return createElement(StrictMode, null, children);
    }
    const first = renderHook(() => useCurrentSentryTransactionName(), {wrapper});
    const second = renderHook(() => useCurrentSentryTransactionName(), {wrapper});

    expect(window.history.pushState).toBe(originalPushState);
    expect(window.history.replaceState).toBe(originalReplaceState);
    expect(jest.getTimerCount()).toBe(2);
    expect(sdk.listeners.size).toBe(2);

    first.unmount();
    expect(jest.getTimerCount()).toBe(1);
    expect(sdk.listeners.size).toBe(1);
    window.history.pushState({}, '', '/teams/456/settings');
    advanceTime();
    expect(second.result.current).toBe(expected);

    second.unmount();
    expect(jest.getTimerCount()).toBe(0);
    expect(sdk.listeners.size).toBe(0);
    expect(window.history.pushState).toBe(originalPushState);
    expect(window.history.replaceState).toBe(originalReplaceState);
  });
});
