import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { User } from './db';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || 'mock_client_id',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'mock_client_secret',
      callbackURL: `${BASE_URL}/api/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0].value;
        if (!email) {
          return done(new Error('No email found from Google'));
        }

        let user = await User.findOne({ email });

        if (user) {
          if (!user.googleId) {
            user.googleId = profile.id;
            await user.save();
          }
          return done(null, user);
        }

        user = new User({
          email,
          username: profile.displayName || email.split('@')[0],
          googleId: profile.id,
          photoUrl: profile.photos?.[0].value,
        });

        await user.save();
        return done(null, user);
      } catch (error) {
        return done(error as Error);
      }
    }
  )
);

passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID || 'mock_client_id',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || 'mock_client_secret',
      callbackURL: `${BASE_URL}/api/auth/github/callback`,
    },
    async (accessToken: string, refreshToken: string, profile: any, done: any) => {
      try {
        const email = profile.emails?.[0].value || (profile._json && profile._json.email);
        if (!email) {
          return done(new Error('No email found from GitHub. Please make your email public on GitHub.'));
        }

        let user = await User.findOne({ email });

        if (user) {
          if (!user.githubId) {
            user.githubId = profile.id;
            await user.save();
          }
          return done(null, user);
        }

        user = new User({
          email,
          username: profile.username || profile.displayName || email.split('@')[0],
          githubId: profile.id,
          photoUrl: profile.photos?.[0].value || (profile._json && profile._json.avatar_url),
        });

        await user.save();
        return done(null, user);
      } catch (error) {
        return done(error as Error);
      }
    }
  )
);

export default passport;
