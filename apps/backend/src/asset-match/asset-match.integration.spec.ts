import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Connection } from '@solana/web3.js';
import * as request from 'supertest';

import { AssetMatchController } from './asset-match.controller';
import { SpotSwapService } from '../spot/spot-swap.service';
import { BlockchainService } from '../wallets/blockchain.service';
import { WalletsService } from '../wallets/wallets.service';
import { TradeSafetyService } from '../trade-safety/trade-safety.service';

/**
 * LIVE NETWORK integration test for POST /embed/asset/match.
 *
 * Exercises the REAL controller, the REAL thematic matcher and the REAL
 * SpotSwapService.quote() over real HTTP, against LIVE Jupiter mainnet and
 * a live Solana RPC. Nothing about the pricing path is stubbed.
 *
 * What it does NOT cover: the full app boot. The backend needs Postgres and
 * Redis, so app.module cannot start in this environment; only the modules this
 * route actually needs are wired here. Guard rails that live at the app level
 * (global prefix, global filters, CORS, rate limiting) are therefore NOT
 * exercised — those still need a deployed environment to prove.
 *
 * OPT-IN. Skipped unless RUN_LIVE_TESTS=1, so a network outage or a Jupiter
 * hiccup can never turn the normal suite red. Run explicitly:
 *   RUN_LIVE_TESTS=1 npm test -- src/asset-match/asset-match.integration.spec.ts
 */
const LIVE = process.env.RUN_LIVE_TESTS === '1';
const d = LIVE ? describe : describe.skip;

d('POST /embed/asset/match — live Jupiter mainnet', () => {
  let app: INestApplication;

  const OLD_ENV = process.env;

  beforeAll(async () => {
    // The surface ships default-off (SpotEnabledGuard); opt in for the test.
    // Both switches: the master embed one and the feature's own.
    process.env = {
      ...OLD_ENV,
      EMBED_ENABLED: 'true',
      SUNRISE_ASSET_ENABLED: 'true',
    };
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetMatchController],
      providers: [
        SpotSwapService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        // Real Connection — the quote path reads mint decimals from mainnet.
        { provide: BlockchainService, useValue: { getConnection: () => connection } },
        // Unused by quote(); the swap path is not exercised here and must not
        // be, since it moves real money.
        { provide: WalletsService, useValue: {} },
        { provide: TradeSafetyService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    process.env = OLD_ENV;
    if (app) await app.close();
  });

  it('matches a real SpaceX headline and returns a live price', async () => {
    const res = await request(app.getHttpServer())
      .post('/embed/asset/match')
      .send({
        url: 'https://example.com/spacex-starship-orbital-test',
        title: 'SpaceX Starship completes first orbital refuelling test',
        ogDescription:
          'The vehicle reached orbit before a controlled splashdown in the Indian Ocean.',
      })
      .expect(201);

    expect(res.body.asset).toBeTruthy();
    expect(res.body.asset.symbol).toBe('SPCX');
    expect(res.body.asset.confidence).toBe('confident');

    // A live price, not a placeholder. Bounds are deliberately wide — this
    // asserts "a real quote came back", not a price prediction.
    const px = res.body.asset.indicativeUsd;
    expect(typeof px).toBe('number');
    expect(px).toBeGreaterThan(1);
    expect(px).toBeLessThan(100_000);
    // eslint-disable-next-line no-console
    console.log(`[live] SPCX indicative = $${px}`);
  }, 60_000);

  it('returns { asset: null } for an unrelated page', async () => {
    const res = await request(app.getHttpServer())
      .post('/embed/asset/match')
      .send({
        url: 'https://example.com/sourdough',
        title: 'Local bakery wins award for its sourdough',
      })
      .expect(201);
    expect(res.body.asset).toBeNull();
  }, 30_000);

  it('does not match a Tesla story that only mentions Musk', async () => {
    const res = await request(app.getHttpServer())
      .post('/embed/asset/match')
      .send({
        url: 'https://example.com/tesla-battery',
        title: 'Elon Musk unveils new Tesla battery',
        ogDescription: 'The automaker says range improves by 20 percent.',
      })
      .expect(201);
    expect(res.body.asset).toBeNull();
  }, 30_000);
});
