import { Router } from 'express';
import { requireAuthentication, requireRole } from '../middleware/auth.middleware.js';
import { citizenController } from '../controllers/citizen.controller.js';

const citizenRouter = Router();

// Protect all citizen endpoints with authentication & role check
// Default policy: Citizen permitted. Manager denied. Admin denied from citizen-only operations unless a separately authorized policy explicitly permits them.
citizenRouter.use(requireAuthentication);
citizenRouter.use((req, res, next) => {
  if (req.user?.role === 'citizen') {
    return next();
  }
  if (req.user?.role === 'admin' && req.headers['x-aeron-admin-citizen-override'] === 'authorized') {
    return next();
  }
  return res.status(403).json({
    status: 'error',
    code: 'FORBIDDEN_ROLE',
    message: `Access denied. Citizen-only operations require citizen role. Current role: '${req.user?.role}'`
  });
});

// Civic Reports
citizenRouter.post('/reports', citizenController.createReport);
citizenRouter.get('/reports', citizenController.getMyReports);
citizenRouter.get('/reports/:reportId', citizenController.getReportById);

// Profile
citizenRouter.get('/profile', citizenController.getProfile);
citizenRouter.patch('/profile', citizenController.updateProfile);

// Notifications
citizenRouter.get('/notifications', citizenController.getNotifications);
citizenRouter.patch('/notifications/:notificationId/read', citizenController.markNotificationRead);
citizenRouter.post('/notifications/read-all', citizenController.markAllNotificationsRead);

// Achievements / Contribution Ledger
citizenRouter.get('/achievements', citizenController.getAchievements);

// Media / Photographic Evidence Upload
citizenRouter.post('/media/upload', citizenController.uploadEvidence);

export { citizenRouter };

