import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../src/app.js';
import { User } from '../../src/models/User.js';
import { CitizenReport } from '../../src/models/CitizenReport.js';
import { Notification } from '../../src/models/Notification.js';
import { MediaAsset } from '../../src/models/MediaAsset.js';
import { storageService } from '../../src/services/storage.service.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { hashPassword } from '../../src/utils/password.js';

describe('AERON TASK 21.1 — Citizen Functional Integrity & Acceptance Suite', () => {
  const app = createApp();

  const citizenId = new mongoose.Types.ObjectId().toString();
  const otherCitizenId = new mongoose.Types.ObjectId().toString();
  const managerId = new mongoose.Types.ObjectId().toString();
  const adminId = new mongoose.Types.ObjectId().toString();

  const citizenToken = signAccessToken(citizenId, 'citizen');
  const otherCitizenToken = signAccessToken(otherCitizenId, 'citizen');
  const managerToken = signAccessToken(managerId, 'manager');
  const adminToken = signAccessToken(adminId, 'admin');

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(User, 'findById').mockImplementation(async (id: any) => {
      const idStr = id?.toString();
      if (idStr === citizenId) {
        return {
          _id: new mongoose.Types.ObjectId(citizenId),
          email: 'citizen.acceptance@aeron.gov',
          name: 'Aeron Citizen',
          role: 'citizen',
          accountStatus: 'active',
          civicPoints: 50,
          createdAt: new Date('2026-01-01')
        } as any;
      }
      if (idStr === otherCitizenId) {
        return {
          _id: new mongoose.Types.ObjectId(otherCitizenId),
          email: 'other.citizen@aeron.gov',
          name: 'Other Citizen',
          role: 'citizen',
          accountStatus: 'active',
          civicPoints: 0,
          createdAt: new Date('2026-01-01')
        } as any;
      }
      if (idStr === managerId) {
        return {
          _id: new mongoose.Types.ObjectId(managerId),
          email: 'manager.audit@aeron.gov',
          name: 'Ops Manager',
          role: 'manager',
          accountStatus: 'active'
        } as any;
      }
      if (idStr === adminId) {
        return {
          _id: new mongoose.Types.ObjectId(adminId),
          email: 'admin.audit@aeron.gov',
          name: 'System Admin',
          role: 'admin',
          accountStatus: 'active'
        } as any;
      }
      return null;
    });
  });

  // =========================================================================
  // 1. CITIZEN-ONLY ACCESS VERIFICATION (SECTION 2)
  // =========================================================================
  describe('1. Citizen-Only Role Authorization Policy', () => {
    it('PERMITS authentic citizen to access citizen routes', async () => {
      vi.spyOn(CitizenReport, 'countDocuments').mockResolvedValue(0 as any);
      vi.spyOn(CitizenReport, 'aggregate').mockResolvedValue([{ totalPoints: 0 }] as any);

      const res = await request(app)
        .get('/api/v1/citizen/profile')
        .set('Authorization', `Bearer ${citizenToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.role).toBe('citizen');
    });

    it('DENIES manager from accessing citizen-only routes with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/citizen/profile')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
      expect(res.body.message).toContain('Citizen-only operations require citizen role');
    });

    it('DENIES administrator by default from citizen routes with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/citizen/profile')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    });

    it('PERMITS administrator with explicit authorization override policy', async () => {
      vi.spyOn(CitizenReport, 'countDocuments').mockResolvedValue(0 as any);
      vi.spyOn(CitizenReport, 'aggregate').mockResolvedValue([{ totalPoints: 0 }] as any);

      const res = await request(app)
        .get('/api/v1/citizen/profile')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-aeron-admin-citizen-override', 'authorized');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });
  });

  // =========================================================================
  // 2. REAL REPORT SUBMISSION & VERIFICATION (SECTION 3)
  // =========================================================================
  describe('2. Real Report Submission & Evidence Lifecycle', () => {
    it('stages photographic evidence via POST /citizen/media/upload', async () => {
      vi.spyOn(storageService, 'upload').mockResolvedValue({
        storageProvider: 'CLOUDINARY',
        storageKey: 'https://res.cloudinary.com/xrsqybb2/image/upload/v1/citizen/evidence/MED-2026-9901.jpg',
        url: 'https://res.cloudinary.com/xrsqybb2/image/upload/v1/citizen/evidence/MED-2026-9901.jpg',
        bytes: 1024,
        checksum: 'mock-checksum-audit',
        contentType: 'image/jpeg'
      });
      const validBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const mockMedia = {
        _id: new mongoose.Types.ObjectId(),
        mediaId: 'MED-2026-9901',
        contentType: 'image/jpeg',
        fileSize: 1024,
        storageKey: 'uploads/citizen/MED-2026-9901.jpg',
        uploadedBy: new mongoose.Types.ObjectId(citizenId)
      };

      vi.spyOn(MediaAsset, 'create').mockResolvedValue(mockMedia as any);

      const res = await request(app)
        .post('/api/v1/citizen/media/upload')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({
          image: validBase64,
          contentType: 'image/jpeg',
          fileName: 'hazard_pothole.jpg'
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.mediaId).toBe('MED-2026-9901');
    });

    it('submits genuine report, generates AER-YYYY-XXXX ID, sets status to SUBMITTED', async () => {
      const mediaId = new mongoose.Types.ObjectId();
      vi.spyOn(MediaAsset, 'find').mockResolvedValue([{ _id: mediaId }] as any);
      vi.spyOn(CitizenReport, 'findOne').mockResolvedValue(null);

      let createdDoc: any = null;
      vi.spyOn(CitizenReport, 'create').mockImplementation(async (doc: any) => {
        createdDoc = doc;
        return {
          ...doc,
          _id: new mongoose.Types.ObjectId()
        } as any;
      });
      vi.spyOn(Notification, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/v1/citizen/reports')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({
          category: 'CROWD_SAFETY',
          description: 'Emergency exit blocked by scaffolding at sector station.',
          location: {
            type: 'Point',
            coordinates: [77.5946, 12.9716]
          },
          mediaAssets: [mediaId.toString()]
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.reportId).toMatch(/^AER-\d{4}-\d{4}$/);
      expect(res.body.data.status).toBe('SUBMITTED');
      expect(res.body.data.currentStage).toBe(1);
      expect(res.body.data.earnedPoints).toBe(25);

      // Verify server-side integrity
      expect(createdDoc.status).toBe('SUBMITTED');
      expect(createdDoc.currentStage).toBe(1);
      expect(createdDoc.earnedPoints).toBe(25);
    });

    it('retrieves submitted report via My Reports and Report Details', async () => {
      const reportId = 'AER-2026-4412';
      const mockReport = {
        _id: new mongoose.Types.ObjectId(),
        reportId,
        citizenId: new mongoose.Types.ObjectId(citizenId),
        category: 'ROAD_STRUCTURAL',
        description: 'Dangerous pothole on bridge ramp',
        location: { type: 'Point', coordinates: [77.5946, 12.9716] },
        status: 'SUBMITTED',
        currentStage: 1,
        earnedPoints: 25,
        submittedAt: new Date(),
        mediaAssets: []
      };

      vi.spyOn(CitizenReport, 'find').mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        populate: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([mockReport])
      } as any);
      vi.spyOn(CitizenReport, 'countDocuments').mockResolvedValue(1);

      // 1. My Reports query
      const listRes = await request(app)
        .get('/api/v1/citizen/reports')
        .set('Authorization', `Bearer ${citizenToken}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.reports.length).toBe(1);
      expect(listRes.body.data.reports[0].reportId).toBe(reportId);

      // 2. Report Details query
      vi.spyOn(CitizenReport, 'findOne').mockReturnValue({
        populate: vi.fn().mockResolvedValue(mockReport)
      } as any);

      const detailRes = await request(app)
        .get(`/api/v1/citizen/reports/${reportId}`)
        .set('Authorization', `Bearer ${citizenToken}`);

      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.reportId).toBe(reportId);
      expect(detailRes.body.data.status).toBe('SUBMITTED');
      expect(detailRes.body.data.currentStage).toBe(1);
    });

    it('STRICTLY BLOCKS other citizens from viewing private report (Zero Leakage)', async () => {
      const privateReport = {
        _id: new mongoose.Types.ObjectId(),
        reportId: 'AER-2026-SECRET',
        citizenId: new mongoose.Types.ObjectId(citizenId),
        category: 'SEARCH_RESCUE',
        description: 'Lost hiker near ravine trail',
        location: { type: 'Point', coordinates: [77.5946, 12.9716] }
      };

      vi.spyOn(CitizenReport, 'findOne').mockReturnValue({
        populate: vi.fn().mockResolvedValue(privateReport)
      } as any);

      // Query attempted by other citizen
      const res = await request(app)
        .get('/api/v1/citizen/reports/AER-2026-SECRET')
        .set('Authorization', `Bearer ${otherCitizenToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('REPORT_NOT_FOUND');
    });
  });

  // =========================================================================
  // 3. STATUS HISTORY & TIMELINE INTEGRITY (SECTION 4)
  // =========================================================================
  describe('3. Status History & Zero-Fictional Stages', () => {
    it('strictly supports genuine backend statuses without fictional timeline stages', async () => {
      const allowedStatuses = [
        'SUBMITTED',
        'MUNICIPAL_REVIEW',
        'INSPECTION_SCHEDULED',
        'AERIAL_VERIFIED',
        'PUBLIC_WORKS_ASSIGNED',
        'RESOLVED',
        'REJECTED'
      ];

      for (const st of allowedStatuses) {
        const report = new CitizenReport({
          reportId: 'AER-2026-TEST',
          citizenId: new mongoose.Types.ObjectId(citizenId),
          category: 'ROAD_STRUCTURAL',
          description: 'Valid road hazard description',
          location: { type: 'Point', coordinates: [77.5946, 12.9716] },
          status: st
        });
        const err = report.validateSync();
        expect(err).toBeUndefined();
      }

      // Invalid / fabricated status rejected by Mongoose model
      const invalidReport = new CitizenReport({
        reportId: 'AER-2026-FAKE',
        citizenId: new mongoose.Types.ObjectId(citizenId),
        category: 'ROAD_STRUCTURAL',
        description: 'Valid road hazard description',
        location: { type: 'Point', coordinates: [77.5946, 12.9716] },
        status: 'DISPATCH_INVENTED_STATUS'
      });
      const err = invalidReport.validateSync();
      expect(err).toBeDefined();
      expect(err?.errors['status']).toBeDefined();
    });
  });
});

