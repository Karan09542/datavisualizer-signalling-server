import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { User } from '../lib/db';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';

// Store active connections: email -> Set of socket IDs
const activeUsers = new Map<string, Set<string>>();
// Map socket ID -> email (for easy cleanup on disconnect)
const socketToEmail = new Map<string, string>();

export const getActiveConnectionsCount = (email: string): number => {
  return activeUsers.get(email)?.size || 0;
};


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
    const userSockets = activeUsers.get(email)!;
    if (userSockets.size > 1) {
      for (const otherSocketId of userSockets) {
        if (otherSocketId !== socket.id) {
          socket.emit('initiate-auto-connect', { targetEmail: email, targetSocketId: otherSocketId });
          break; 
        }
      }
    } else {
      // Auto-Connect Logic 2: Default Target
      try {
        const dbUser = await User.findOne({ email }).select('defaultTargetEmail');
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
        let socketIdToSend = targetSocketId;
        if (!socketIdToSend || socketIdToSend === socket.id) {
          for (const sId of targetSockets) {
            if (sId !== socket.id) {
              socketIdToSend = sId;
              break;
            }
          }
        }
        
        if (socketIdToSend && socketIdToSend !== socket.id) {
          io.to(socketIdToSend).emit('webrtc-offer', {
            senderEmail: email,
            senderSocketId: socket.id,
            offer
          });
        }
      }
    });

    socket.on('webrtc-answer', ({ targetEmail, targetSocketId, answer }) => {
      let socketIdToSend = targetSocketId;
      if (!socketIdToSend && targetEmail) {
        const targetSockets = activeUsers.get(targetEmail);
        if (targetSockets) {
          for (const sId of targetSockets) {
            if (sId !== socket.id) {
              socketIdToSend = sId;
              break;
            }
          }
        }
      }

      if (socketIdToSend) {
        io.to(socketIdToSend).emit('webrtc-answer', {
          senderEmail: email,
          senderSocketId: socket.id,
          answer
        });
      }
    });

    socket.on('webrtc-ice-candidate', ({ targetEmail, targetSocketId, candidate }) => {
      let socketIdToSend = targetSocketId;
      if (!socketIdToSend && targetEmail) {
        const targetSockets = activeUsers.get(targetEmail);
        if (targetSockets) {
          for (const sId of targetSockets) {
            if (sId !== socket.id) {
              socketIdToSend = sId;
              break;
            }
          }
        }
      }

      if (socketIdToSend) {
        io.to(socketIdToSend).emit('webrtc-ice-candidate', {
          senderEmail: email,
          senderSocketId: socket.id,
          candidate
        });
      }
    });

    socket.on('check-presence', (emails: string[]) => {
      const presence: Record<string, boolean> = {};
      emails.forEach(e => {
        // If checking own email, we want to know if there are *other* devices, so count > 1
        // If checking another email, count > 0
        const count = getActiveConnectionsCount(e);
        if (e === email) {
          presence[e] = count > 1;
        } else {
          presence[e] = count > 0;
        }
      });
      socket.emit('presence-result', presence);
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
