import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../lib/db';
import passport from 'passport';
import { authenticate, AuthRequest } from '../lib/authMiddleware';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';
// Clients refresh while in use, so an idle gap this long is what actually signs a user out
const TOKEN_TTL = '30d';

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email: user.email, username: user.username, photoUrl: user.photoUrl } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.json({ success: true });
});

// Exchange a still-valid token for a fresh one so active users are never signed out mid-use
router.post('/refresh', authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await User.findById(req.user!.userId)
      .select('email username photoUrl defaultTargetEmail autoConnectEnabled');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({ token, user });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Google OAuth
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err: any, user: any, info: any) => {
    if (err) {
      console.error('Google OAuth error:', err);
      return res.redirect(`${FRONTEND_URL}?error=${encodeURIComponent(err.message || 'GoogleLoginFailed')}`);
    }
    if (!user) {
      const msg = info?.message || 'GoogleLoginFailed';
      return res.redirect(`${FRONTEND_URL}?error=${encodeURIComponent(msg)}`);
    }
    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`${FRONTEND_URL}?token=${token}`);
  })(req, res, next);
});

// GitHub OAuth
router.get('/github', passport.authenticate('github', { scope: ['user:email'] }));

router.get('/github/callback', (req, res, next) => {
  passport.authenticate('github', { session: false }, (err: any, user: any, info: any) => {
    if (err) {
      console.error('GitHub OAuth error:', err);
      return res.redirect(`${FRONTEND_URL}?error=${encodeURIComponent(err.message || 'GithubLoginFailed')}`);
    }
    if (!user) {
      const msg = info?.message || 'GithubLoginFailed';
      return res.redirect(`${FRONTEND_URL}?error=${encodeURIComponent(msg)}`);
    }
    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`${FRONTEND_URL}?token=${token}`);
  })(req, res, next);
});

export default router;
