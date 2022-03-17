import styled from 'styled-components';
import Button from '@material-ui/core/Button';
import { CandyMachineAccount } from './candy-machine';
import { FairLaunchAccount } from './fair-launch';
import { CircularProgress } from '@material-ui/core';
import { GatewayStatus, useGateway } from '@civic/solana-gateway-react';
import { useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  findGatewayToken,
  getGatewayTokenAddressForOwnerAndGatekeeperNetwork,
  onGatewayTokenChange,
  removeAccountChangeListener,
} from '@identity.com/solana-gateway-ts';

export const CTAButton = styled(Button)`
  width: 100%;
  height: 60px;
  margin-top: 10px;
  margin-bottom: 5px;
  background: linear-gradient(180deg, #604ae5 0%, #813eee 100%);
  color: white;
  font-size: 16px;
  font-weight: bold;
`; // add your styles here

export const MintButton = ({
  onMint,
  candyMachine,
  fairLaunch,
  isMinting,
  fairLaunchBalance,
}: {
  onMint: () => Promise<void>;
  candyMachine: CandyMachineAccount | undefined;
  fairLaunch?: FairLaunchAccount | undefined;
  isMinting: boolean;
  fairLaunchBalance: number;
}) => {
  const { requestGatewayToken, gatewayStatus } = useGateway();
  const [clicked, setClicked] = useState(false);

  const [verified, setVerified] = useState(false);
  const [webSocketSubscriptionId, setWebSocketSubscriptionId] = useState(-1);

  const wallet = useWallet();
  const connection = useConnection();

  useEffect(() => {
    if (gatewayStatus == GatewayStatus.ACTIVE && clicked) {
      console.log('Minting');
      onMint();
      setClicked(false);
    }
  }, [gatewayStatus, clicked]);

  useEffect(() => {
    const mint = async () => {
      console.log('Minting')
      await removeAccountChangeListener(
        connection.connection,
        webSocketSubscriptionId
      )
      await onMint();

      setClicked(false);
      setVerified(false)
      setWebSocketSubscriptionId(-1)
    }
    if (verified && clicked) {
      mint()
    }
  }, [verified, clicked, webSocketSubscriptionId, connection.connection, onMint])

  return (
    <CTAButton
      disabled={
        candyMachine?.state.isSoldOut ||
        isMinting ||
        !candyMachine?.state.isActive ||
        (fairLaunch?.ticket?.data?.state.punched && fairLaunchBalance === 0)
      }
      onClick={async () => {
        setClicked(true);
        if (candyMachine?.state.isActive && candyMachine?.state.gatekeeper) {
          const network =
            candyMachine.state.gatekeeper.gatekeeperNetwork.toBase58();
          if (network === 'ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6') {
            if (gatewayStatus === GatewayStatus.ACTIVE) {
              setClicked(true);
            } else {
              await requestGatewayToken();
            }
          } else if (
            network === 'ttib7tuX8PTWPqFsmUFQTj78MbRhUmqxidJRDv4hRRE' ||
            network === 'tibePmPaoTgrs929rWpu755EXaxC7M3SthVCf6GzjZt'
          ) {
            const gatewayToken = await findGatewayToken(
              connection.connection,
              wallet.publicKey!,
              candyMachine.state.gatekeeper.gatekeeperNetwork,
            );

            if (gatewayToken?.isValid()) {
              await onMint();
              setClicked(false);
            } else {
              let endpoint = process.env.REACT_APP_SOLANA_RPC_HOST!;
              if (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
              if (!endpoint.startsWith('https'))
                endpoint = 'https' + endpoint.slice(4);

              window.open(
                `https://verify.encore.fans/?endpoint=${endpoint}&gkNetwork=${network}`,
                '_blank',
              );

              const gatewayTokenAddress =
                await getGatewayTokenAddressForOwnerAndGatekeeperNetwork(
                  wallet.publicKey!,
                  candyMachine.state.gatekeeper.gatekeeperNetwork,
                );

              setWebSocketSubscriptionId(
                onGatewayTokenChange(
                  connection.connection,
                  gatewayTokenAddress,
                  () => setVerified(true),
                  'confirmed',
                ),
              );
            }
          } else {
            setClicked(false);
            throw new Error(`Unknown Gatekeeper Network: ${network}`);
          }
        } else {
          await onMint();
          setClicked(false);
        }
      }}
      variant="contained"
    >
      {fairLaunch?.ticket?.data?.state.punched && fairLaunchBalance === 0 ? (
        'MINTED'
      ) : candyMachine?.state.isSoldOut ? (
        'SOLD OUT'
      ) : (clicked || isMinting) ? (
        <CircularProgress />
      ) : (
        'MINT'
      )}
    </CTAButton>
  );
};
