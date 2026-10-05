import { Router } from "express";
import { createMapLayersRouter } from "../controllers/mapLayers.controller.js";

/** Mount in Express with: app.use('/api', createApiRouter()). */
export function createApiRouter() {
  const router = Router();
  router.use("/data", createMapLayersRouter());
  return router;
}

