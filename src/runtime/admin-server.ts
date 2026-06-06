import http from 'http';
import { GameEngine } from '../core/game-engine';
import type { BettingService } from '../core/betting-service';
import { ExposureEngine } from '../core/exposure-engine';

export function startAdminServer(port: number, gameEngine: GameEngine, bettingEngine: BettingService) {
  const exposure = new ExposureEngine();
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method ?? 'GET';
    // POST endpoint to update playerMixParams
    if (url === '/admin/player-mix-params' && method === 'POST') {
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        const json = body ? JSON.parse(body) : {};
        try { (gameEngine as any).fairness?.setPlayerMixParams?.(json); } catch (e) {}
        const updated = (gameEngine as any).fairness?.getPlayerMixParams?.() ?? null;
        const payload = { ok: true, playerMixParams: updated, elasticity: (gameEngine as any).getElasticity?.() ?? null };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload, null, 2));
        return;
      } catch (e) {
        res.statusCode = 500;
        res.end('invalid body');
        return;
      }
    }
    if (url === '/admin/state') {
      const state = gameEngine.getState();
      let exposureSnap = null;
      if (state) {
        try {
          const bets = await bettingEngine.getBetsForRound(state.roundId);
          exposureSnap = exposure.computeSnapshot(bets);
          // include per-user profiles for users who bet this round (if available)
          const profiles = [] as any[];
          for (const b of bets) {
            try {
              const p = (bettingEngine as any).userBehavior?.getProfile?.(b.userId);
              if (p) profiles.push(p);
            } catch (e) {}
          }
          const payload = {
            shapingParams: (gameEngine as any).fairness?.getShapingParams?.() ?? null,
            shapingPreset: (gameEngine as any).fairness?.getShapingPreset?.() ?? null,
            systemState: (gameEngine as any).fairness?.getVolatilityState?.() ?? null,
            playerMixParams: (gameEngine as any).fairness?.getPlayerMixParams?.() ?? null,
            elasticity: (gameEngine as any).getElasticity?.() ?? null,
            state,
            exposure: exposureSnap,
            userProfiles: profiles,
            playerMixHistory: (gameEngine as any).fairness?.getPlayerMixHistory?.() ?? [],
          };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(payload, null, 2));
          return;
        } catch (e) {}
      }
      const payload = {
        shapingParams: (gameEngine as any).fairness?.getShapingParams?.() ?? null,
        shapingPreset: (gameEngine as any).fairness?.getShapingPreset?.() ?? null,
        systemState: (gameEngine as any).fairness?.getVolatilityState?.() ?? null,
        playerMixParams: (gameEngine as any).fairness?.getPlayerMixParams?.() ?? null,
        elasticity: (gameEngine as any).getElasticity?.() ?? null,
        state,
        exposure: exposureSnap,
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`[Admin] listening on http://localhost:${port}`);
  });

  return server;
}
