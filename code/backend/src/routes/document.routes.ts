import { Router } from 'express';

import * as documentController from '../controllers/document.controller';
import { authenticate } from '../middleware/auth.middleware';
import { uploadSingleFile } from '../middleware/upload.middleware';

export const documentRouter = Router();

documentRouter.use(authenticate);

documentRouter.post('/', uploadSingleFile, documentController.upload);
documentRouter.get('/', documentController.list);
documentRouter.get('/:id', documentController.getOne);
documentRouter.get('/:id/print-issues', documentController.printIssues);
documentRouter.get('/:id/view', documentController.view);
documentRouter.get('/:id/download', documentController.download);
documentRouter.delete('/:id', documentController.remove);
