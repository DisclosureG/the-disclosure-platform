// Shot registry: kind → component + props type. Add a shot here and it becomes
// available to any video config.
import { TitleShot, type TitleShotProps } from "./TitleShot";
import { StepsShot, type StepsShotProps } from "./StepsShot";
import { TiersShot, type TiersShotProps } from "./TiersShot";
import { TaxonomyShot, type TaxonomyShotProps } from "./TaxonomyShot";
import { LifecycleShot, type LifecycleShotProps } from "./LifecycleShot";
import { VotingShot, type VotingShotProps } from "./VotingShot";
import { WalletShot, type WalletShotProps } from "./WalletShot";
import { PeerGridShot, type PeerGridShotProps } from "./PeerGridShot";
import { WallsShot, type WallsShotProps } from "./WallsShot";
import { RefusalsShot, type RefusalsShotProps } from "./RefusalsShot";
import { CTAShot, type CTAShotProps } from "./CTAShot";
import { OutroShot, type OutroShotProps } from "./OutroShot";

export type ShotPropsByKind = {
  title: TitleShotProps;
  steps: StepsShotProps;
  tiers: TiersShotProps;
  taxonomy: TaxonomyShotProps;
  lifecycle: LifecycleShotProps;
  voting: VotingShotProps;
  wallet: WalletShotProps;
  "peer-grid": PeerGridShotProps;
  walls: WallsShotProps;
  refusals: RefusalsShotProps;
  cta: CTAShotProps;
  outro: OutroShotProps;
};

export type ShotKind = keyof ShotPropsByKind;

export const SHOT_COMPONENTS: { [K in ShotKind]: React.FC<ShotPropsByKind[K]> } = {
  title: TitleShot,
  steps: StepsShot,
  tiers: TiersShot,
  taxonomy: TaxonomyShot,
  lifecycle: LifecycleShot,
  voting: VotingShot,
  wallet: WalletShot,
  "peer-grid": PeerGridShot,
  walls: WallsShot,
  refusals: RefusalsShot,
  cta: CTAShot,
  outro: OutroShot,
};
