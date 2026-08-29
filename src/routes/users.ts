import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import prisma from '../lib/db';
import { authenticate, AuthRequest } from '../lib/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit before compression

// Update username or photo
router.put('/me', authenticate, upload.single('photo'), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { username } = req.body;
    const file = req.file;

    const dataToUpdate: any = {};
    if (username) dataToUpdate.username = username;

    if (file) {
      // Compress and resize image to fit under 65KB (BLOB limit)
      const compressedBuffer = await sharp(file.buffer)
        .resize(256, 256, { fit: 'cover' })
        .webp({ quality: 60 }) // High compression
        .toBuffer();

      if (compressedBuffer.length > 65000) {
        return res.status(400).json({ error: 'Image too large even after compression' });
      }

      dataToUpdate.photoData = compressedBuffer;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
      select: { id: true, email: true, username: true, defaultTargetEmail: true, photoData: true } // Return user data (photoData as buffer)
    });

    res.json({
      ...updatedUser,
      photoData: updatedUser.photoData ? `data:image/webp;base64,${updatedUser.photoData.toString('base64')}` : null
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update default target
router.put('/me/default-target', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { defaultTargetEmail } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { defaultTargetEmail },
      select: { id: true, email: true, username: true, defaultTargetEmail: true }
    });
    res.json(updatedUser);
  } catch (error) {
    console.error('Update default target error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search users by email
router.get('/search', authenticate, async (req: AuthRequest, res) => {
  try {
    const { email } = req.query;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Query parameter email is required' });
    }

    const users = await prisma.user.findMany({
      where: { email: { contains: email } },
      select: { id: true, email: true, username: true, photoData: true },
      take: 10
    });

    const formattedUsers = users.map((u: any) => ({
      ...u,
      photoData: u.photoData ? `data:image/webp;base64,${u.photoData.toString('base64')}` : null
    }));

    res.json(formattedUsers);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete account
router.delete('/me', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    await prisma.user.delete({ where: { id: userId } });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
