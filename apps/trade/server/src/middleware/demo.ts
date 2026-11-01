import type { Request, Response, NextFunction } from 'express';

export function attachDemoFlag(req: Request, _res: Response, next: NextFunction): void {
  req.isDemo = req.session?.demo === true;
  next();
}
