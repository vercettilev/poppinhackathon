import { Module } from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

import { AssetMatchController } from './asset-match.controller';
import { IconService } from './icon.service';
import { SparkService } from './spark.service';
import { EmbedEnabledGuard } from '../embed/embed-enabled.guard';
import { FirebaseModule } from '../firebase/firebase.module';
import { SpotModule } from '../spot/spot.module';

/**
 * §Sunrise PoC — page-to-asset thematic matching.
 * SpotModule provides the public quote (indicative opening price) and the
 * feature's own kill-switch guard; EmbedEnabledGuard is declared here so the
 * master embed kill-switch applies to this route too.
 *
 * FirebaseModule + JwtService are here for ONE route: POST swap, the only
 * authenticated one. FirebaseAuthGuard is instantiated per-module by Nest, so a
 * @UseGuards() on a controller obliges the controller's own module to supply
 * that guard's dependencies — and getting it wrong does not fail typecheck,
 * does not fail unit tests, and does not fail the build. It fails at BOOT, for
 * the whole application, which is exactly how this shipped a 502 on every route
 * in the API rather than a 500 on the one route that used the guard.
 */
@Module({
  imports: [SpotModule, FirebaseModule],
  controllers: [AssetMatchController],
  providers: [EmbedEnabledGuard, JwtService, SparkService, IconService],
})
export class AssetMatchModule {}
