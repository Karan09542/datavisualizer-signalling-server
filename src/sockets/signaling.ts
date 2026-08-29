import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../lib/db';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';

// Store active connections: email -> Set of socket IDs
const activeUsers = new Map<string, Set<string>>();
// Map socket ID -> email (for easy cleanup on disconnect)
const socketToEmail = new Map<string, string>();

export const setupSignalingSockets = (io: Server) => {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: string, email: string };
      (socket as any).user = payload;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const user = (socket as any).user;
    const email = user.email;

    console.log(`User connected: ${email} (Socket ID: ${socket.id})`);

    // Add to active users
    if (!activeUsers.has(email)) {
      activeUsers.set(email, new Set());
    }
    activeUsers.get(email)!.add(socket.id);
    socketToEmail.set(socket.id, email);

    // Auto-Connect Logic 1: Same User
    // If the same user is connected on another device, try to auto-connect them.
    const userSockets = activeUsers.get(email)!;
    if (userSockets.size > 1) {
      for (const otherSocketId of userSockets) {
        if (otherSocketId !== socket.id) {
          // Tell the newly connected socket to initiate an offer to the other socket
          socket.emit('initiate-auto-connect', { targetEmail: email, targetSocketId: otherSocketId });
          break; // Just connect to one for now
        }
      }
    } else {
      // Auto-Connect Logic 2: Default Target
      // Check if this user has a default target set and auto-connect is enabled on client side
      // The client will handle whether the toggle is on, but we can proactively notify if the target is online.
      try {
        const dbUser = await prisma.user.findUnique({ where: { email }, select: { defaultTargetEmail: true } });
        if (dbUser?.defaultTargetEmail) {
          const targetSockets = activeUsers.get(dbUser.defaultTargetEmail);
          if (targetSockets && targetSockets.size > 0) {
            const targetSocketId = Array.from(targetSockets)[0];
            socket.emit('initiate-auto-connect', { targetEmail: dbUser.defaultTargetEmail, targetSocketId });
          }
        }
      } catch (e) {
        console.error('Error checking default target on connection', e);
      }
    }

    // Signaling events
    socket.on('webrtc-offer', ({ targetEmail, targetSocketId, offer }) => {
      const targetSockets = activeUsers.get(targetEmail);
      if (targetSockets) {
        // If a specific socket is provided (e.g. for same user), send to that. Otherwise send to the first one available.
        const socketIdToSend = (targetSocketId && targetSockets.has(targetSocketId)) 
          ? targetSocketId 
          : Array.from(targetSockets)[0];
        
        io.to(socketIdToSend).emit('webrtc-offer', {
          senderEmail: email,
          senderSocketId: socket.id,
          offer
        });
      }
    });

    socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
      io.to(targetSocketId).emit('webrtc-answer', {
        senderEmail: email,
        senderSocketId: socket.id,
        answer
      });
    });

    socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit('webrtc-ice-candidate', {
        senderEmail: email,
        senderSocketId: socket.id,
        candidate
      });
    });

    socket.on('disconnect', () => {
      console.log(`User disconnected: ${email} (Socket ID: ${socket.id})`);
      const userSockets = activeUsers.get(email);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          activeUsers.delete(email);
        }
      }
      socketToEmail.delete(socket.id);
    });
  });
};
