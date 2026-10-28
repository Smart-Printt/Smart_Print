import { Router } from 'express';

import * as orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';

export const orderRouter = Router();

orderRouter.use(authenticate);

orderRouter.post('/', orderController.create);
orderRouter.get('/', orderController.list);
// Declared before '/:id' so "summary" is not read as an order id.
orderRouter.get('/summary', requireRole('ADMIN'), orderController.summary);
orderRouter.get('/:id', orderController.getOne);
orderRouter.patch('/:id/cancel', orderController.cancel);
