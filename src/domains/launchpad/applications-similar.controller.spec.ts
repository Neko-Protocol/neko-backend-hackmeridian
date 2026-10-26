import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AdminAuthService } from "../platform/admin-auth/admin-auth.service";
import { AdminApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { VaultOpsService } from "./chain/vault-ops.service";

const APPLICATION_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT = `/v1/launchpad/admin/applications/${APPLICATION_ID}/similar`;
const EMPTY_MEMORY = {
  summary: { approved: 0, rejected: 0, changes_requested: 0 },
  cases: [],
};

describe("GET admin applications/:id/similar", () => {
  let app: INestApplication;
  const adminSimilar = jest.fn().mockResolvedValue(EMPTY_MEMORY);
  const verifyAdminToken = jest.fn(async (token: string) => token === "admin");

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminApplicationsController],
      providers: [
        { provide: ApplicationsService, useValue: { adminSimilar } },
        { provide: AdminAuthService, useValue: { verifyAdminToken } },
        { provide: VaultOpsService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("v1");
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    );
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it("requires an admin bearer token", async () => {
    await request(app.getHttpServer()).get(ENDPOINT).expect(401);
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set("Authorization", "Bearer issuer")
      .expect(401);
    expect(adminSimilar).not.toHaveBeenCalled();
  });

  it("returns the real memory response with a default limit of five", async () => {
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set("Authorization", "Bearer admin")
      .expect(200, EMPTY_MEMORY);
    expect(verifyAdminToken).toHaveBeenCalledWith("admin");
    expect(adminSimilar).toHaveBeenCalledWith(APPLICATION_ID, 5);
  });

  it("transforms a valid limit before calling the service", async () => {
    await request(app.getHttpServer())
      .get(`${ENDPOINT}?limit=20`)
      .set("Authorization", "Bearer admin")
      .expect(200);
    expect(adminSimilar).toHaveBeenCalledWith(APPLICATION_ID, 20);
  });

  it.each(["0", "21", "1.5", "invalid"])(
    "rejects limit=%s before querying cases",
    async (limit) => {
      await request(app.getHttpServer())
        .get(`${ENDPOINT}?limit=${limit}`)
        .set("Authorization", "Bearer admin")
        .expect(400);
      expect(adminSimilar).not.toHaveBeenCalled();
    }
  );

  it("rejects an invalid application ID", async () => {
    await request(app.getHttpServer())
      .get("/v1/launchpad/admin/applications/invalid/similar")
      .set("Authorization", "Bearer admin")
      .expect(400);
    expect(adminSimilar).not.toHaveBeenCalled();
  });
});
