// /api/edit/* — Video editor library routes.
//
// Upload is open (anonymous saves land as public); delete is
// vault-required (cost protection + private item visibility).

import { Router } from "express";
import { maybeVault, requireVault } from "../../services/auth/vault.js";
import {
  editUploadMiddleware,
  editProcessMiddleware,
  postEditUpload,
  postEditProcess,
  getEditList,
  getEditFile,
  getEditPoster,
  deleteEdit,
  postEditBulkDelete,
} from "../../controllers/edit/index.js";

const router = Router();

router.post(  "/edit/upload",        maybeVault, editUploadMiddleware, postEditUpload);
router.post(  "/edit/process",       maybeVault, editProcessMiddleware, postEditProcess);
router.get(   "/edit/list",          maybeVault, getEditList);
router.get(   "/edit/file/:name",    maybeVault, getEditFile);
router.get(   "/edit/poster/:name",  maybeVault, getEditPoster);
router.delete("/edit/:id",           requireVault, deleteEdit);
router.post(  "/edit/bulk-delete",   requireVault, postEditBulkDelete);

export default router;
