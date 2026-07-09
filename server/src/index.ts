import './config.js';
import express from 'express';
import cors from 'cors';
import { migrate } from './db/migrate.js';
import briefsRouter from './routes/briefs.js';
import articlesRouter from './routes/articles.js';
import storiesRouter from './routes/stories.js';
import followsRouter from './routes/follows.js';
import adminRouter from './routes/admin.js';
import chatRouter from './routes/chat.js';
import feedRouter from './routes/feed.js';

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }));
app.use(express.json());

app.use('/api/briefs', briefsRouter);
app.use('/api/articles', articlesRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/follows', followsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/chat', chatRouter);
app.use('/api/feed', feedRouter);

const PORT = Number(process.env.PORT ?? 3000);

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
