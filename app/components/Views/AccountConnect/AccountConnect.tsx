// Third party dependencies.
import { useNavigation } from '@react-navigation/native';
import { isEqual } from 'lodash';
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Modal from 'react-native-modal';
import { useSelector } from 'react-redux';
// External dependencies.
import { strings } from '../../../../locales/i18n';
import { AvatarAccountType } from '../../../component-library/components/Avatars/Avatar/variants/AvatarAccount';
import BottomSheet, {
  BottomSheetRef,
} from '../../../component-library/components/BottomSheets/BottomSheet';
import { IconName } from '../../../component-library/components/Icons/Icon';
import {
  ToastContext,
  ToastVariants,
} from '../../../component-library/components/Toast';
import { ToastOptions } from '../../../component-library/components/Toast/Toast.types';
import { USER_INTENT } from '../../../constants/permissions';
import { MetaMetricsEvents } from '../../../core/Analytics';
import Engine from '../../../core/Engine';
import { selectAccountsLength } from '../../../selectors/accountTrackerController';
import {
  selectInternalAccounts,
  selectSelectedInternalAccountChecksummedAddress,
} from '../../../selectors/accountsController';
import { isDefaultAccountName } from '../../../util/ENSUtils';
import Logger from '../../../util/Logger';
import getAccountNameWithENS from '../../../util/accounts';
import {
  getAddressAccountType,
  safeToChecksumAddress,
} from '../../../util/address';
import {
  getHost,
  getUrlObj,
  prefixUrlWithProtocol,
} from '../../../util/browser';
import { getActiveTabUrl } from '../../../util/transactions';
import { Account, useAccounts } from '../../hooks/useAccounts';

// Internal dependencies.
import { PermissionsRequest } from '@metamask/permission-controller';
import { ImageURISource, ImageSourcePropType, StyleSheet } from 'react-native';
import URLParse from 'url-parse';
import PhishingModal from '../../../components/UI/PhishingModal';
import { useMetrics } from '../../../components/hooks/useMetrics';
import Routes from '../../../constants/navigation/Routes';
import {
  MM_BLOCKLIST_ISSUE_URL,
  MM_ETHERSCAN_URL,
  MM_PHISH_DETECT_URL,
} from '../../../constants/urls';
import AppConstants from '../../../core/AppConstants';
import SDKConnect from '../../../core/SDKConnect/SDKConnect';
import DevLogger from '../../../core/SDKConnect/utils/DevLogger';
import { RootState } from '../../../reducers';
import { trackDappViewedEvent } from '../../../util/metrics';
import { useTheme } from '../../../util/theme';
import useFavicon from '../../hooks/useFavicon/useFavicon';
import { SourceType } from '../../hooks/useMetrics/useMetrics.types';
import {
  AccountConnectProps,
  AccountConnectScreens,
} from './AccountConnect.types';
import AccountConnectMultiSelector from './AccountConnectMultiSelector';
import AccountConnectSingle from './AccountConnectSingle';
import AccountConnectSingleSelector from './AccountConnectSingleSelector';
import { PermissionsSummaryProps } from '../../../components/UI/PermissionsSummary/PermissionsSummary.types';
import PermissionsSummary from '../../../components/UI/PermissionsSummary';
import {
  isMultichainVersion1Enabled,
  getNetworkImageSource,
} from '../../../util/networks';
import NetworkConnectMultiSelector from '../NetworkConnect/NetworkConnectMultiSelector';
import { PermissionKeys } from '../../../core/Permissions/specifications';
import { CaveatTypes } from '../../../core/Permissions/constants';
import { useNetworkInfo } from '../../../selectors/selectedNetworkController';
import { AvatarSize } from '../../../component-library/components/Avatars/Avatar';
import { selectNetworkConfigurations } from '../../../selectors/networkController';

const createStyles = () =>
  StyleSheet.create({
    fullScreenModal: {
      flex: 1,
    },
  });

const AccountConnect = (props: AccountConnectProps) => {
  const { colors } = useTheme();
  const styles = createStyles();
  const { hostInfo, permissionRequestId } = props.route.params;
  const [isLoading, setIsLoading] = useState(false);
  const navigation = useNavigation();
  const { trackEvent } = useMetrics();

  const [blockedUrl, setBlockedUrl] = useState('');

  const selectedWalletAddress = useSelector(
    selectSelectedInternalAccountChecksummedAddress,
  );
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>(
    selectedWalletAddress ? [selectedWalletAddress] : [],
  );
  const [confirmedAddresses, setConfirmedAddresses] =
    useState<string[]>(selectedAddresses);

  const sheetRef = useRef<BottomSheetRef>(null);
  const [screen, setScreen] = useState<AccountConnectScreens>(
    AccountConnectScreens.SingleConnect,
  );
  const { accounts, ensByAccountAddress } = useAccounts({
    isLoading,
  });
  const previousIdentitiesListSize = useRef<number>();
  const internalAccounts = useSelector(selectInternalAccounts);
  const [showPhishingModal, setShowPhishingModal] = useState(false);
  const [userIntent, setUserIntent] = useState(USER_INTENT.None);

  const [selectedNetworkAvatars, setSelectedNetworkAvatars] = useState<
    {
      size: AvatarSize;
      name: string;
      imageSource: ImageSourcePropType;
    }[]
  >([]);

  const { toastRef } = useContext(ToastContext);
  const accountAvatarType = useSelector((state: RootState) =>
    state.settings.useBlockieIcon
      ? AvatarAccountType.Blockies
      : AvatarAccountType.JazzIcon,
  );

  // origin is set to the last active tab url in the browser which can conflict with sdk
  const inappBrowserOrigin: string = useSelector(getActiveTabUrl, isEqual);
  const accountsLength = useSelector(selectAccountsLength);
  const { wc2Metadata } = useSelector((state: RootState) => state.sdk);

  const networkConfigurations = useSelector(selectNetworkConfigurations);

  const { origin: channelIdOrHostname } = hostInfo.metadata as {
    id: string;
    origin: string;
  };

  const isUUID = (str: string) => {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  };

  const isChannelId = isUUID(channelIdOrHostname);

  const sdkConnection = SDKConnect.getInstance().getConnection({
    channelId: channelIdOrHostname,
  });

  const isOriginMMSDKRemoteConn = sdkConnection !== undefined;

  const isOriginWalletConnect =
    !isOriginMMSDKRemoteConn && wc2Metadata?.id && wc2Metadata?.id.length > 0;

  const dappIconUrl = sdkConnection?.originatorInfo?.icon;
  const dappUrl = sdkConnection?.originatorInfo?.url ?? '';

  const { domainTitle, hostname } = useMemo(() => {
    let title = '';
    let dappHostname = dappUrl || channelIdOrHostname;

    if (
      isOriginMMSDKRemoteConn &&
      channelIdOrHostname.startsWith(AppConstants.MM_SDK.SDK_REMOTE_ORIGIN)
    ) {
      title = getUrlObj(
        channelIdOrHostname.split(AppConstants.MM_SDK.SDK_REMOTE_ORIGIN)[1],
      ).origin;
    } else if (isOriginWalletConnect) {
      title = getUrlObj(channelIdOrHostname).origin;
      dappHostname = title;
    } else if (!isChannelId && (dappUrl || channelIdOrHostname)) {
      title = prefixUrlWithProtocol(dappUrl || channelIdOrHostname);
      dappHostname = inappBrowserOrigin;
    } else {
      title = strings('sdk.unknown');
    }

    return { domainTitle: title, hostname: dappHostname };
  }, [
    isOriginWalletConnect,
    inappBrowserOrigin,
    isOriginMMSDKRemoteConn,
    isChannelId,
    dappUrl,
    channelIdOrHostname,
  ]);

  const urlWithProtocol =
    hostname && !isUUID(hostname)
      ? prefixUrlWithProtocol(getHost(hostname))
      : domainTitle;

  const { chainId } = useNetworkInfo(hostname);

  const [selectedChainIds, setSelectedChainIds] = useState<string[]>(() =>
    chainId ? [chainId] : [],
  );
  const [selectedNetworkIds, setSelectedNetworkIds] = useState<string[]>(() =>
    chainId ? [chainId] : [],
  );

  useEffect(() => {
    if (chainId) {
      const initialNetworkAvatar = {
        size: AvatarSize.Xs,
        name: networkConfigurations[chainId]?.name || '',
        // @ts-expect-error getNetworkImageSourcenot yet typed
        imageSource: getNetworkImageSource({ chainId }),
      };
      setSelectedNetworkAvatars([initialNetworkAvatar]);

      setSelectedChainIds([chainId]);
    }
  }, [chainId, networkConfigurations]);

  const handleUpdateNetworkPermissions = useCallback(async () => {
    let hasPermittedChains = false;
    let chainsToPermit = selectedChainIds.length > 0 ? selectedChainIds : [];
    if (chainId && chainsToPermit.length === 0) {
      chainsToPermit = [chainId];
    }

    try {
      hasPermittedChains = Engine.context.PermissionController.hasCaveat(
        new URL(hostname).hostname,
        PermissionKeys.permittedChains,
        CaveatTypes.restrictNetworkSwitching,
      );
    } catch {
      // noop
    }

    if (hasPermittedChains) {
      Engine.context.PermissionController.updateCaveat(
        new URL(hostname).hostname,
        PermissionKeys.permittedChains,
        CaveatTypes.restrictNetworkSwitching,
        chainsToPermit,
      );
    } else {
      Engine.context.PermissionController.grantPermissionsIncremental({
        subject: {
          origin: new URL(hostname).hostname,
        },
        approvedPermissions: {
          [PermissionKeys.permittedChains]: {
            caveats: [
              {
                type: CaveatTypes.restrictNetworkSwitching,
                value: chainsToPermit,
              },
            ],
          },
        },
      });
    }
  }, [selectedChainIds, chainId, hostname]);

  const isAllowedOrigin = useCallback((origin: string) => {
    const { PhishingController } = Engine.context;

    // Update phishing configuration if it is out-of-date
    // This is async but we are not `await`-ing it here intentionally, so that we don't slow
    // down network requests. The configuration is updated for the next request.
    PhishingController.maybeUpdateState();

    const phishingControllerTestResult = PhishingController.test(origin);

    return !phishingControllerTestResult.result;
  }, []);

  useEffect(() => {
    const url = dappUrl || channelIdOrHostname || '';
    const isAllowed = isAllowedOrigin(url);

    if (!isAllowed) {
      setBlockedUrl(dappUrl);
      setShowPhishingModal(true);
    }
  }, [isAllowedOrigin, dappUrl, channelIdOrHostname]);

  const faviconSource = useFavicon(
    inappBrowserOrigin || (!isChannelId ? channelIdOrHostname : ''),
  );

  const actualIcon = useMemo(() => {
    // Priority to dappIconUrl
    if (dappIconUrl) {
      return { uri: dappIconUrl };
    }

    if (isOriginWalletConnect) {
      // fetch icon from store
      return { uri: wc2Metadata?.icon ?? '' };
    }

    const favicon = faviconSource as ImageURISource;
    if ('uri' in favicon) {
      return faviconSource;
    }

    return { uri: '' };
  }, [dappIconUrl, wc2Metadata, faviconSource, isOriginWalletConnect]);

  const secureIcon = useMemo(
    () =>
      (getUrlObj(hostname) as URLParse<string>).protocol === 'https:'
        ? IconName.Lock
        : IconName.LockSlash,
    [hostname],
  );

  const eventSource = useMemo(() => {
    // walletconnect channelId format: app.name.org
    // sdk channelId format: uuid
    // inappbrowser channelId format: app.name.org but origin is set
    if (isOriginWalletConnect) {
      return SourceType.WALLET_CONNECT;
    }

    if (sdkConnection) {
      return SourceType.SDK;
    }

    return SourceType.IN_APP_BROWSER;
  }, [isOriginWalletConnect, sdkConnection]);

  // Refreshes selected addresses based on the addition and removal of accounts.
  useEffect(() => {
    // Extract the address list from the internalAccounts array
    const accountsAddressList = internalAccounts.map((account) =>
      account.address.toLowerCase(),
    );

    if (previousIdentitiesListSize.current !== accountsAddressList.length) {
      // Clean up selected addresses that are no longer part of accounts.
      const updatedSelectedAddresses = selectedAddresses.filter((address) =>
        accountsAddressList.includes(address.toLowerCase()),
      );
      setSelectedAddresses(updatedSelectedAddresses);
      previousIdentitiesListSize.current = accountsAddressList.length;
    }
  }, [internalAccounts, selectedAddresses]);

  const cancelPermissionRequest = useCallback(
    (requestId) => {
      DevLogger.log(
        `AccountConnect::cancelPermissionRequest requestId=${requestId} channelIdOrHostname=${channelIdOrHostname} accountsLength=${accountsLength}`,
      );
      Engine.context.PermissionController.rejectPermissionsRequest(requestId);
      if (channelIdOrHostname && accountsLength === 0) {
        // Remove Potential SDK connection
        SDKConnect.getInstance().removeChannel({
          channelId: channelIdOrHostname,
          sendTerminate: true,
        });
      }

      trackEvent(MetaMetricsEvents.CONNECT_REQUEST_CANCELLED, {
        number_of_accounts: accountsLength,
        source: SourceType.PERMISSION_SYSTEM,
      });
    },
    [accountsLength, channelIdOrHostname, trackEvent],
  );

  const navigateToUrlInEthPhishingModal = useCallback(
    (url: string | null) => {
      setShowPhishingModal(false);
      cancelPermissionRequest(permissionRequestId);
      navigation.goBack();
      setIsLoading(false);

      if (url !== null) {
        navigation.navigate(Routes.BROWSER.HOME, {
          screen: Routes.BROWSER.VIEW,
          params: {
            newTabUrl: url,
            timestamp: Date.now(),
          },
        });
      }
    },
    [cancelPermissionRequest, navigation, permissionRequestId],
  );

  const continueToPhishingSite = useCallback(() => {
    setShowPhishingModal(false);
  }, []);

  const goToETHPhishingDetector = useCallback(() => {
    navigateToUrlInEthPhishingModal(MM_PHISH_DETECT_URL);
  }, [navigateToUrlInEthPhishingModal]);

  const goToFilePhishingIssue = useCallback(() => {
    navigateToUrlInEthPhishingModal(MM_BLOCKLIST_ISSUE_URL);
  }, [navigateToUrlInEthPhishingModal]);

  const goToEtherscam = useCallback(() => {
    navigateToUrlInEthPhishingModal(MM_ETHERSCAN_URL);
  }, [navigateToUrlInEthPhishingModal]);

  const goBackToSafety = useCallback(() => {
    navigateToUrlInEthPhishingModal(null); // No URL means just go back to safety without navigating to a new page
  }, [navigateToUrlInEthPhishingModal]);

  const triggerDappViewedEvent = useCallback(
    (numberOfConnectedAccounts: number) =>
      // Track dapp viewed event
      trackDappViewedEvent({ hostname, numberOfConnectedAccounts }),
    [hostname],
  );

  const handleConnect = useCallback(async () => {
    const request: PermissionsRequest = {
      ...hostInfo,
      metadata: {
        ...hostInfo.metadata,
        origin: channelIdOrHostname,
      },
      approvedAccounts: selectedAddresses,
    };
    const connectedAccountLength = selectedAddresses.length;
    const activeAddress = selectedAddresses[0];
    const activeAccountName = getAccountNameWithENS({
      accountAddress: activeAddress,
      accounts,
      ensByAccountAddress,
    });

    try {
      setIsLoading(true);
      /*
       * TODO: update request object to match PermissionsRequest type
       */
      await Engine.context.PermissionController.acceptPermissionsRequest(
        request,
      );

      triggerDappViewedEvent(connectedAccountLength);

      trackEvent(MetaMetricsEvents.CONNECT_REQUEST_COMPLETED, {
        number_of_accounts: accountsLength,
        number_of_accounts_connected: connectedAccountLength,
        account_type: getAddressAccountType(activeAddress),
        source: eventSource,
      });
      let labelOptions: ToastOptions['labelOptions'] = [];
      if (connectedAccountLength > 1) {
        labelOptions = [
          { label: `${connectedAccountLength} `, isBold: true },
          {
            label: `${strings('toast.accounts_connected')}`,
          },
          { label: `\n${activeAccountName} `, isBold: true },
          { label: strings('toast.now_active') },
        ];
      } else {
        labelOptions = [
          { label: `${activeAccountName} `, isBold: true },
          { label: strings('toast.connected_and_active') },
        ];
      }
      toastRef?.current?.showToast({
        variant: ToastVariants.Account,
        labelOptions,
        accountAddress: activeAddress,
        accountAvatarType,
        hasNoTimeout: false,
      });
    } catch (e) {
      if (e instanceof Error) {
        Logger.error(e, 'Error while trying to connect to a dApp.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [
    eventSource,
    selectedAddresses,
    hostInfo,
    accounts,
    ensByAccountAddress,
    accountAvatarType,
    toastRef,
    accountsLength,
    channelIdOrHostname,
    triggerDappViewedEvent,
    trackEvent,
  ]);

  const handleCreateAccount = useCallback(
    async (isMultiSelect?: boolean) => {
      const { KeyringController } = Engine.context;
      try {
        setIsLoading(true);
        const addedAccountAddress = await KeyringController.addNewAccount();
        const checksummedAddress = safeToChecksumAddress(
          addedAccountAddress,
        ) as string;
        !isMultiSelect && setSelectedAddresses([checksummedAddress]);
        trackEvent(MetaMetricsEvents.ACCOUNTS_ADDED_NEW_ACCOUNT);
      } catch (e) {
        if (e instanceof Error) {
          Logger.error(e, 'error while trying to add a new account');
        }
      } finally {
        setIsLoading(false);
      }
    },
    [trackEvent],
  );

  const handleNetworksSelected = useCallback(
    (newSelectedChainIds: string[]) => {
      setSelectedChainIds(newSelectedChainIds);
      setSelectedNetworkIds(newSelectedChainIds);

      const newNetworkAvatars = newSelectedChainIds.map(
        (newSelectedChainId) => ({
          size: AvatarSize.Xs,
          // @ts-expect-error - networkConfigurations is not typed
          name: networkConfigurations[newSelectedChainId]?.name || '',
          // @ts-expect-error - getNetworkImageSource is not typed
          imageSource: getNetworkImageSource({ chainId: newSelectedChainId }),
        }),
      );
      setSelectedNetworkAvatars(newNetworkAvatars);

      setScreen(AccountConnectScreens.SingleConnect);
    },
    [networkConfigurations, setScreen],
  );

  const hideSheet = (callback?: () => void) =>
    sheetRef?.current?.onCloseBottomSheet?.(callback);

  /**
   * User intent is set on AccountConnectSingle,
   * AccountConnectSingleSelector & AccountConnectMultiSelector.
   *
   * We need to know where the user clicks to decide what
   * should happen to the Permission Request Promise.
   * We then trigger the corresponding side effects &
   * control the Bottom Sheet visibility.
   */
  useEffect(() => {
    if (userIntent === USER_INTENT.None) return;

    const handleUserActions = (action: USER_INTENT) => {
      switch (action) {
        case USER_INTENT.Confirm: {
          handleConnect();
          handleUpdateNetworkPermissions();
          hideSheet();
          break;
        }
        case USER_INTENT.Create: {
          handleCreateAccount();
          break;
        }
        case USER_INTENT.CreateMultiple: {
          handleCreateAccount(true);
          break;
        }
        case USER_INTENT.Cancel: {
          hideSheet(() => cancelPermissionRequest(permissionRequestId));
          break;
        }
        case USER_INTENT.Import: {
          navigation.navigate('ImportPrivateKeyView');
          // TODO: Confirm if this is where we want to track importing an account or within ImportPrivateKeyView screen.
          trackEvent(MetaMetricsEvents.ACCOUNTS_IMPORTED_NEW_ACCOUNT);
          break;
        }
        case USER_INTENT.ConnectHW: {
          navigation.navigate('ConnectQRHardwareFlow');
          // TODO: Confirm if this is where we want to track connecting a hardware wallet or within ConnectQRHardwareFlow screen.
          trackEvent(MetaMetricsEvents.CONNECT_HARDWARE_WALLET);

          break;
        }
      }
    };

    handleUserActions(userIntent);

    setUserIntent(USER_INTENT.None);
  }, [
    navigation,
    userIntent,
    sheetRef,
    cancelPermissionRequest,
    permissionRequestId,
    handleCreateAccount,
    handleConnect,
    trackEvent,
    handleUpdateNetworkPermissions,
  ]);

  const handleSheetDismiss = () => {
    if (!permissionRequestId || userIntent !== USER_INTENT.None) return;

    cancelPermissionRequest(permissionRequestId);
  };

  const renderSingleConnectScreen = useCallback(() => {
    const selectedAddress = selectedAddresses[0];
    const selectedAccount = accounts.find(
      (account) =>
        safeToChecksumAddress(account.address) ===
        safeToChecksumAddress(selectedAddress),
    );
    const ensName = ensByAccountAddress[selectedAddress];
    const defaultSelectedAccount: Account | undefined = selectedAccount
      ? {
          ...selectedAccount,
          name:
            isDefaultAccountName(selectedAccount.name) && ensName
              ? ensName
              : selectedAccount.name,
        }
      : undefined;
    return (
      <AccountConnectSingle
        onSetSelectedAddresses={setSelectedAddresses}
        connection={sdkConnection}
        onSetScreen={setScreen}
        onUserAction={setUserIntent}
        defaultSelectedAccount={defaultSelectedAccount}
        isLoading={isLoading}
        favicon={actualIcon}
        secureIcon={secureIcon}
        urlWithProtocol={urlWithProtocol}
      />
    );
  }, [
    accounts,
    ensByAccountAddress,
    selectedAddresses,
    isLoading,
    setScreen,
    setSelectedAddresses,
    actualIcon,
    secureIcon,
    sdkConnection,
    urlWithProtocol,
    setUserIntent,
  ]);

  const renderPermissionsSummaryScreen = useCallback(() => {
    const permissionsSummaryProps: PermissionsSummaryProps = {
      currentPageInformation: {
        currentEnsName: '',
        icon: faviconSource as string,
        url: urlWithProtocol,
      },
      onEdit: () => {
        setScreen(AccountConnectScreens.MultiConnectSelector);
      },
      onEditNetworks: () =>
        setScreen(AccountConnectScreens.MultiConnectNetworkSelector),
      onUserAction: setUserIntent,
      isAlreadyConnected: false,
      accountAddresses: confirmedAddresses,
      accounts,
      // @ts-expect-error imageSource not yet typed
      networkAvatars: selectedNetworkAvatars,
    };
    return <PermissionsSummary {...permissionsSummaryProps} />;
  }, [
    faviconSource,
    urlWithProtocol,
    confirmedAddresses,
    selectedNetworkAvatars,
    accounts,
  ]);

  const renderSingleConnectSelectorScreen = useCallback(
    () => (
      <AccountConnectSingleSelector
        accounts={accounts}
        ensByAccountAddress={ensByAccountAddress}
        onSetScreen={setScreen}
        onSetSelectedAddresses={setSelectedAddresses}
        selectedAddresses={selectedAddresses}
        isLoading={isLoading}
        onUserAction={setUserIntent}
      />
    ),
    [
      accounts,
      ensByAccountAddress,
      selectedAddresses,
      isLoading,
      setUserIntent,
      setSelectedAddresses,
      setScreen,
    ],
  );

  const renderMultiConnectSelectorScreen = useCallback(
    () => (
      <AccountConnectMultiSelector
        accounts={accounts}
        ensByAccountAddress={ensByAccountAddress}
        selectedAddresses={selectedAddresses}
        onSelectAddress={setSelectedAddresses}
        isLoading={isLoading}
        favicon={faviconSource}
        secureIcon={secureIcon}
        urlWithProtocol={urlWithProtocol}
        onUserAction={setUserIntent}
        onBack={() => {
          setSelectedAddresses(confirmedAddresses);
          setScreen(AccountConnectScreens.SingleConnect);
        }}
        connection={sdkConnection}
        hostname={hostname}
        onPrimaryActionButtonPress={() => {
          setConfirmedAddresses(selectedAddresses);
          return isMultichainVersion1Enabled
            ? setScreen(AccountConnectScreens.SingleConnect)
            : undefined;
        }}
      />
    ),
    [
      accounts,
      ensByAccountAddress,
      selectedAddresses,
      confirmedAddresses,
      isLoading,
      faviconSource,
      secureIcon,
      urlWithProtocol,
      sdkConnection,
      hostname,
    ],
  );

  const renderMultiConnectNetworkSelectorScreen = useCallback(
    () => (
      <NetworkConnectMultiSelector
        onSelectNetworkIds={setSelectedAddresses}
        isLoading={isLoading}
        onUserAction={setUserIntent}
        urlWithProtocol={urlWithProtocol}
        hostname={new URL(urlWithProtocol).hostname}
        onBack={() => setScreen(AccountConnectScreens.SingleConnect)}
        onNetworksSelected={handleNetworksSelected}
        initialChainId={chainId}
        selectedChainIds={selectedNetworkIds}
        isInitializedWithPermittedChains={false}
      />
    ),
    [
      isLoading,
      urlWithProtocol,
      chainId,
      handleNetworksSelected,
      selectedNetworkIds,
    ],
  );

  const renderPhishingModal = useCallback(
    () => (
      <Modal
        isVisible={showPhishingModal}
        animationIn="slideInUp"
        animationOut="slideOutDown"
        style={styles.fullScreenModal}
        backdropOpacity={1}
        backdropColor={colors.error.default}
        animationInTiming={300}
        animationOutTiming={300}
        useNativeDriver
      >
        <PhishingModal
          fullUrl={blockedUrl}
          goToETHPhishingDetector={goToETHPhishingDetector}
          continueToPhishingSite={continueToPhishingSite}
          goToEtherscam={goToEtherscam}
          goToFilePhishingIssue={goToFilePhishingIssue}
          goBackToSafety={goBackToSafety}
        />
      </Modal>
    ),
    [
      blockedUrl,
      colors.error.default,
      continueToPhishingSite,
      goBackToSafety,
      goToETHPhishingDetector,
      goToEtherscam,
      goToFilePhishingIssue,
      showPhishingModal,
      styles.fullScreenModal,
    ],
  );

  const renderConnectScreens = useCallback(() => {
    switch (screen) {
      case AccountConnectScreens.SingleConnect:
        return isMultichainVersion1Enabled
          ? renderPermissionsSummaryScreen()
          : renderSingleConnectScreen();
      case AccountConnectScreens.SingleConnectSelector:
        return renderSingleConnectSelectorScreen();
      case AccountConnectScreens.MultiConnectSelector:
        return renderMultiConnectSelectorScreen();
      case AccountConnectScreens.MultiConnectNetworkSelector:
        return renderMultiConnectNetworkSelectorScreen();
    }
  }, [
    screen,
    renderSingleConnectScreen,
    renderPermissionsSummaryScreen,
    renderSingleConnectSelectorScreen,
    renderMultiConnectSelectorScreen,
    renderMultiConnectNetworkSelectorScreen,
  ]);

  return (
    <BottomSheet onClose={handleSheetDismiss} ref={sheetRef}>
      {renderConnectScreens()}
      {renderPhishingModal()}
    </BottomSheet>
  );
};

export default AccountConnect;
