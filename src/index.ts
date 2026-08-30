import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import { setupSignalingSockets } from './sockets/signaling';
import { connectDB } from './lib/db';
import passport from './lib/passport';

dotenv.config();

const ALLOWED_ORIGIN = process.env.NODE_ENV === 'production'
  ? 'https://datavisualizer.urlmediainspector.dev'
  : '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Middleware
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

// Socket.io
setupSignalingSockets(io);

const PORT = process.env.PORT || 4000;

// Connect to DB first, then start the server
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
});
