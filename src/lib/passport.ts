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
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(null, false, { message: 'No email found from Google' });
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
        let email = profile.emails?.[0]?.value || (profile._json && profile._json.email);
        
        // Fallback: Manually fetch emails if not present
        if (!email) {
          try {
            const emailRes = await fetch('https://api.github.com/user/emails', {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'DataVisualizer',
                'Accept': 'application/vnd.github.v3+json'
              }
            });
            if (emailRes.ok) {
              const emails = await emailRes.json();
              // Find primary or first verified email
              const primaryEmail = emails.find((e: any) => e.primary) || emails.find((e: any) => e.verified) || emails[0];
              if (primaryEmail && primaryEmail.email) {
                email = primaryEmail.email;
              }
            }
          } catch (e) {
            console.error('Failed to fetch github emails manually:', e);
          }
        }

        if (!email) {
          return done(null, false, { message: 'No email found from GitHub. Please make your email public on GitHub.' });
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
