import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { User } from '../lib/db';
import { authenticate, AuthRequest } from '../lib/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// Configure Cloudinary
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});

// Update username or photo
router.put('/me', authenticate, upload.single('photo'), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { username } = req.body;
    const file = req.file;

    const dataToUpdate: any = {};
    if (username) dataToUpdate.username = username;

    if (file) {
      // Upload to Cloudinary using a stream
      const uploadPromise = new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'visualizer_avatars', format: 'webp', transformation: [{ width: 256, height: 256, crop: 'fill' }] },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(file.buffer);
      });

      const result = await uploadPromise as any;
      dataToUpdate.photoUrl = result.secure_url;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, dataToUpdate, { new: true })
                                  .select('email username photoUrl defaultTargetEmail');

    res.json(updatedUser);
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

    const updatedUser = await User.findByIdAndUpdate(userId, { defaultTargetEmail }, { new: true })
                                  .select('email username photoUrl defaultTargetEmail');
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

    const users = await User.find({ email: { $regex: email, $options: 'i' } })
                            .select('email username photoUrl')
                            .limit(10);

    res.json(users);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete account
router.delete('/me', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    await User.findByIdAndDelete(userId);
    // Optionally: delete image from Cloudinary here
    res.json({ success: true });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
