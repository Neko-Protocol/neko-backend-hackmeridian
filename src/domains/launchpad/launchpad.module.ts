import { Module } from "@nestjs/common";
import { AdminAuthModule } from "../platform/admin-auth/admin-auth.module";
import { AccountsService } from "./accounts.service";
import {
  AdminApplicationsController,
  ApplicationsController,
} from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { AssistantStorageService } from "./assistant/assistant-storage.service";
import { AssistantController } from "./assistant/assistant.controller";
import { AssistantService } from "./assistant/assistant.service";
import {
  FaucetController,
  OpportunitiesController,
} from "./chain/chain.controller";
import { LaunchpadChainService } from "./chain/chain.service";
import { FaucetService } from "./chain/faucet.service";
import { LaunchService } from "./chain/launch.service";
import { OnchainIdentityService } from "./chain/onchain-identity.service";
import { OpportunitiesService } from "./chain/opportunities.service";
import { VaultOpsService } from "./chain/vault-ops.service";
import { RagClient } from "./assistant/rag.client";
import { DiditWebhookController } from "./didit-webhook.controller";
import { InvestorsController } from "./investors.controller";
import { InvestorsService } from "./investors.service";
import { LaunchpadController } from "./launchpad.controller";
import { PrecedentsService } from "./precedents.service";
import { ProIdentityService } from "./pro-identity.service";
import { VerificationsService } from "./verifications.service";

@Module({
  imports: [AdminAuthModule],
  controllers: [
    LaunchpadController,
    DiditWebhookController,
    ApplicationsController,
    AdminApplicationsController,
    AssistantController,
    InvestorsController,
    FaucetController,
    OpportunitiesController,
  ],
  providers: [
    VerificationsService,
    AccountsService,
    InvestorsService,
    ProIdentityService,
    ApplicationsService,
    PrecedentsService,
    AssistantService,
    AssistantStorageService,
    RagClient,
    LaunchpadChainService,
    LaunchService,
    VaultOpsService,
    OnchainIdentityService,
    FaucetService,
    OpportunitiesService,
  ],
})
export class LaunchpadModule {}
