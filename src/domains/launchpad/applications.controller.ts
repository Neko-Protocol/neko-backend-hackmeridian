import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  ParseIntPipe,
  Query,
  Req,
  UnauthorizedException,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  AdminAuthGuard,
  type AdminRequest,
} from "../platform/admin-auth/admin-auth.guard";
import { ApplicationsService } from "./applications.service";
import {
  AssistantStorageService,
  MAX_APPLICATION_FILE_BYTES,
  applicationMediaType,
} from "./assistant/assistant-storage.service";
import { AssistantService } from "./assistant/assistant.service";
import { LaunchService } from "./chain/launch.service";
import {
  VaultOpsService,
  type ChainActionResult,
} from "./chain/vault-ops.service";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { DecideApplicationDto } from "./dto/decide-application.dto";
import { LaunchApplicationDto } from "./dto/launch-application.dto";
import { ListApplicationsQueryDto } from "./dto/list-applications-query.dto";
import { ReviewMilestoneDto } from "./dto/review-milestone.dto";
import { SimilarApplicationsQueryDto } from "./dto/similar-applications-query.dto";
import {
  LaunchpadErrorCode,
  type AdminApplicationView,
  type ApplicationView,
  type SimilarApplicationsResponse,
} from "./launchpad.types";

@ApiTags("launchpad")
@ApiTooManyRequestsResponse({ description: "Rate-limited." })
@Controller("launchpad/applications")
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly assistant: AssistantService,
    private readonly storage: AssistantStorageService,
    private readonly launches: LaunchService
  ) {}

  private bearerToken(authorization?: string): string {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      throw new UnauthorizedException({
        code: LaunchpadErrorCode.MISSING_ACCESS_TOKEN,
      });
    }
    return token;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Submit a tokenization application (issuer)." })
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(
    @Body() dto: CreateApplicationDto,
    @Headers("authorization") authorization?: string
  ): Promise<ApplicationView> {
    return this.applications.create(this.bearerToken(authorization), dto);
  }

  @Post("documents")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Upload a document to attach to an application (issuer).",
  })
  @ApiBearerAuth()
  @ApiConsumes("multipart/form-data")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_APPLICATION_FILE_BYTES },
    })
  )
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers("authorization") authorization?: string
  ): Promise<{ document: { name: string; url: string } }> {
    const account = await this.assistant.verifiedAccount(
      this.bearerToken(authorization)
    );
    if (!file) throw new BadRequestException({ code: "FILE_REQUIRED" });
    if (file.size > MAX_APPLICATION_FILE_BYTES) {
      throw new PayloadTooLargeException({
        code: "FILE_TOO_LARGE",
        message: "Files can be up to 20 MB.",
      });
    }
    const mediaType = applicationMediaType(file.originalname);
    if (!mediaType) {
      throw new UnsupportedMediaTypeException({
        code: "UNSUPPORTED_TYPE",
        message: "Use PDF, Word, Excel, CSV, TXT or an image.",
      });
    }
    return {
      document: await this.storage.uploadApplicationDocument(
        account.account.id,
        file,
        mediaType
      ),
    };
  }

  @Post(":id/launch")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Deploy an approved application's token, compliance and vault (issuer). Resumes a failed launch.",
  })
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  launch(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LaunchApplicationDto,
    @Headers("authorization") authorization?: string
  ): Promise<ApplicationView> {
    return this.launches.launch(this.bearerToken(authorization), id, dto);
  }

  @Post(":id/skip-review")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Demo only: approve your own submitted application without review (REVIEW_SKIP_ENABLED).",
  })
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  skipReview(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("authorization") authorization?: string
  ): Promise<ApplicationView> {
    return this.applications.skipReview(this.bearerToken(authorization), id);
  }

  @Get("mine")
  @ApiOperation({ summary: "List applications for the logged-in issuer." })
  @ApiBearerAuth()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  listMine(
    @Headers("authorization") authorization?: string
  ): Promise<ApplicationView[]> {
    return this.applications.listMine(this.bearerToken(authorization));
  }
}

@ApiTags("launchpad-admin")
@ApiTooManyRequestsResponse({ description: "Rate-limited." })
@ApiUnauthorizedResponse({ description: "Missing or invalid admin session." })
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller("launchpad/admin/applications")
export class AdminApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly vaults: VaultOpsService
  ) {}

  @Get()
  @ApiOperation({ summary: "List tokenization applications (admin)." })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  list(@Query() query: ListApplicationsQueryDto): Promise<ApplicationView[]> {
    return this.applications.adminList(query.status);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a tokenization application (admin)." })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  get(@Param("id", ParseUUIDPipe) id: string): Promise<AdminApplicationView> {
    return this.applications.adminGet(id);
  }

  @Get(":id/similar")
  @ApiOperation({ summary: "Find similar decided applications (admin)." })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  similar(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: SimilarApplicationsQueryDto
  ): Promise<SimilarApplicationsResponse> {
    return this.applications.adminSimilar(id, query.limit);
  }

  @Post(":id/decision")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record a review decision (admin)." })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  decide(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DecideApplicationDto,
    @Req() req: AdminRequest
  ): Promise<AdminApplicationView> {
    return this.applications.adminDecide(id, dto, req.adminEmail ?? null);
  }

  @Post(":id/vault/close-funding")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Close the vault's funding round (admin)." })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  closeFunding(
    @Param("id", ParseUUIDPipe) id: string
  ): Promise<ChainActionResult> {
    return this.vaults.closeFunding(id);
  }

  @Post(":id/vault/release")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Release the raise to the issuer (admin)." })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  release(@Param("id", ParseUUIDPipe) id: string): Promise<ChainActionResult> {
    return this.vaults.release(id);
  }

  @Post(":id/vault/milestones/:index/review")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Approve or reject milestone evidence (admin)." })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  reviewMilestone(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("index", ParseIntPipe) index: number,
    @Body() dto: ReviewMilestoneDto
  ): Promise<ChainActionResult> {
    return this.vaults.reviewMilestone(id, index, dto.approved, dto.note);
  }
}
