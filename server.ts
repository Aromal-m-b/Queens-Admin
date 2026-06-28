import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { createServer as createViteServer } from "vite";

// Load environment variables
dotenv.config();

const PORT = 3000;
const app = express();
app.use(express.json());

// MongoDB URI verification and fallback setup
let mongoUri = process.env.MONGODB_URI || "";
const isValidUri = (uri: string): boolean => {
  const trimmed = uri.trim();
  return trimmed.startsWith("mongodb://") || trimmed.startsWith("mongodb+srv://");
};

const DEFAULT_FALLBACK_URI = "mongodb+srv://agent:aromal@queens-dev.u1uyh5l.mongodb.net/?appName=Queens-Dev";
let isMongoConfigured = true;

if (!isValidUri(mongoUri)) {
  if (mongoUri && mongoUri.trim() !== "") {
    console.warn(`[Admin Service] Configured MONGODB_URI is invalid: "${mongoUri}". Falling back to default URI.`);
  }
  mongoUri = DEFAULT_FALLBACK_URI;
}

if (!isValidUri(mongoUri)) {
  console.error("[Admin Service] No valid MongoDB URI found. Local fallback storage will be used.");
  isMongoConfigured = false;
}

const dbName = "queens-dev";
const collectionName = "levels";

// Define a local database file to persist levels if MongoDB is not available
const LOCAL_DB_PATH = path.join(process.cwd(), "custom_levels.json");

// In-memory cache of levels for immediate access
let localLevels: any[] = [];

// Load initial local levels from file if it exists
try {
  if (fs.existsSync(LOCAL_DB_PATH)) {
    const fileContent = fs.readFileSync(LOCAL_DB_PATH, "utf8");
    localLevels = JSON.parse(fileContent);
    console.log(`[Admin Service] Loaded ${localLevels.length} custom boards from local JSON storage.`);
  }
} catch (e) {
  console.error("[Admin Service] Failed to load local levels file:", e);
}

function saveLocalLevels() {
  try {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(localLevels, null, 2), "utf8");
  } catch (e) {
    console.error("[Admin Service] Failed to save local levels file:", e);
  }
}

// A simple mock matching the subset of MongoDB collection methods used in this application
class LocalCollectionMock {
  find() {
    return {
      toArray: async () => {
        return JSON.parse(JSON.stringify(localLevels));
      }
    };
  }

  async updateOne(filter: { id: string }, update: { $set: any }, options?: { upsert?: boolean }) {
    const id = filter.id;
    const payload = update.$set || {};
    const existingIndex = localLevels.findIndex(item => item.id === id);
    
    if (existingIndex !== -1) {
      localLevels[existingIndex] = { ...localLevels[existingIndex], ...payload, id };
    } else if (options?.upsert) {
      localLevels.push({ ...payload, id });
    } else {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    
    saveLocalLevels();
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: existingIndex === -1 ? 1 : 0 };
  }

  async deleteOne(filter: { id: string }) {
    const id = filter.id;
    const initialLen = localLevels.length;
    localLevels = localLevels.filter(item => item.id !== id);
    saveLocalLevels();
    return { deletedCount: initialLen - localLevels.length };
  }
}

class LocalDbMock {
  collection(_name: string) {
    return new LocalCollectionMock();
  }
}

const localDbMockInstance = new LocalDbMock();
let useLocalFallback = !isMongoConfigured;
let mongoClient: MongoClient | null = null;

async function getDb() {
  if (useLocalFallback) {
    return localDbMockInstance as any;
  }

  if (!mongoClient) {
    try {
      console.log("[Admin Service] Connecting to MongoDB...");
      mongoClient = new MongoClient(mongoUri, {
        connectTimeoutMS: 4000,
        socketTimeoutMS: 30000,
      });
      await mongoClient.connect();
      console.log("[Admin Service] Connected to MongoDB Atlas successfully");
    } catch (err: any) {
      console.error("[Admin Service] MongoDB Connection failed. Switching to local fallback storage. Error:", err?.message || err);
      mongoClient = null;
      useLocalFallback = true;
      return localDbMockInstance as any;
    }
  }
  
  try {
    return mongoClient.db(dbName);
  } catch (err: any) {
    console.error("[Admin Service] MongoDB selection failed. Switching to local fallback storage. Error:", err?.message || err);
    useLocalFallback = true;
    return localDbMockInstance as any;
  }
}

// Resilient database operation wrapper to gracefully catch and handle runtime connection/SSL errors
async function executeDbQuery<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const db = await getDb();
  try {
    return await fn(db);
  } catch (err: any) {
    if (!useLocalFallback) {
      console.error("[Admin Service] Database operation failed. Forcing local fallback and retrying...", err?.message || err);
      useLocalFallback = true;
      if (mongoClient) {
        try {
          await mongoClient.close();
        } catch (e) {}
        mongoClient = null;
      }
      const fallbackDb = await getDb();
      return await fn(fallbackDb);
    }
    throw err;
  }
}

// Help parse difficulty dynamically via string slicing
function getDifficultyFromId(id: string): "easy" | "medium" | "hard" {
  const sliced = id.slice(0, -2);
  if (sliced === "easy" || sliced === "easy-") return "easy";
  if (sliced === "medium" || sliced === "medium-") return "medium";
  if (sliced === "hard" || sliced === "hard-") return "hard";
  
  const parts = id.split("-");
  if (parts.length > 0) {
    const p = parts[0];
    if (p === "easy" || p === "medium" || p === "hard") return p as any;
  }
  return "easy";
}

function cleanLevelForDb(level: any) {
  const clean = { ...level };
  delete clean._id;
  delete clean.difficulty;
  return clean;
}

function mapDbLevelToClient(level: any) {
  const clean = { ...level };
  delete clean._id;
  clean.difficulty = getDifficultyFromId(level.id);
  return clean;
}

// API: List custom boards
app.get("/api/boards", async (_req, res) => {
  try {
    const boards = await executeDbQuery(async (db) => {
      return await db.collection(collectionName).find({}).toArray();
    });
    res.json(boards.map(mapDbLevelToClient));
  } catch (err: any) {
    console.error("Error retrieving boards:", err);
    res.status(500).json({ error: "Failed to retrieve boards", details: err?.message });
  }
});

// API: Save file to assets directory
app.post("/api/save-asset", async (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || content === undefined) {
      return res.status(400).json({ error: "Missing filename or content" });
    }

    // Only allow alphanumeric characters, dots, underscores, and dashes
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeFilename) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const assetsDir = path.join(process.cwd(), "src", "assets");
    
    // Ensure src/assets exists
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    const filePath = path.join(assetsDir, safeFilename);
    fs.writeFileSync(filePath, content, "utf8");

    console.log(`[Admin Service] Saved asset: ${safeFilename}`);
    res.json({ success: true, path: `/src/assets/${safeFilename}` });
  } catch (err: any) {
    console.error("Failed to save asset:", err);
    res.status(500).json({ error: "Failed to save asset", details: err?.message });
  }
});

// API: Sync custom boards incrementally
app.post("/api/sync", async (req, res) => {
  try {
    const { clientLevels } = req.body;
    const clientLevelsList = Array.isArray(clientLevels) ? clientLevels : [];
    
    const dbLevels = await executeDbQuery(async (db) => {
      return await db.collection(collectionName).find({}).toArray();
    });

    const dbLevelsMap = new Map<string, any>();
    dbLevels.forEach((level: any) => {
      const cleanLevel = mapDbLevelToClient(level);
      dbLevelsMap.set(level.id, cleanLevel);
    });

    const toUpsert: any[] = [];
    const toDelete: string[] = [];

    dbLevelsMap.forEach((dbLevel, id) => {
      const clientPair = clientLevelsList.find((pair: any) => pair.id === id);
      if (!clientPair) {
        toUpsert.push(dbLevel);
      } else {
        const dbUpdatedAt = dbLevel.updatedAt || 0;
        const clientUpdatedAt = clientPair.updatedAt || 0;
        if (dbUpdatedAt > clientUpdatedAt) {
          toUpsert.push(dbLevel);
        }
      }
    });

    clientLevelsList.forEach((clientPair: any) => {
      if (!dbLevelsMap.has(clientPair.id)) {
        toDelete.push(clientPair.id);
      }
    });

    res.json({
      toUpsert,
      toDelete,
      success: true
    });
  } catch (err: any) {
    console.error("Synchronization failed:", err);
    res.status(500).json({ error: "Sync failed", details: err?.message });
  }
});

// API: Upsert board (saves or edits a boards)
app.post("/api/boards", async (req, res) => {
  try {
    const board = req.body;
    if (!board.id || !board.size || !board.grid || !board.solution) {
      return res.status(400).json({ error: "Missing required board configuration fields" });
    }

    board.updatedAt = Date.now();
    const dbPayload = cleanLevelForDb(board);

    await executeDbQuery(async (db) => {
      return await db.collection(collectionName).updateOne(
        { id: board.id },
        { $set: dbPayload },
        { upsert: true }
      );
    });

    res.status(201).json({ success: true, board: mapDbLevelToClient(dbPayload) });
  } catch (err: any) {
    console.error("Failed to save board:", err);
    res.status(500).json({ error: "Failed to save board", details: err?.message });
  }
});

// API: Edit existing board attributes
app.put("/api/boards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    updates.updatedAt = Date.now();
    const dbPayload = cleanLevelForDb(updates);

    const result = await executeDbQuery(async (db) => {
      return await db.collection(collectionName).updateOne(
        { id },
        { $set: dbPayload }
      );
    });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Board not found" });
    }

    res.json({ success: true, id, updates: mapDbLevelToClient(dbPayload) });
  } catch (err: any) {
    console.error("Failed to update board:", err);
    res.status(500).json({ error: "Failed to update board", details: err?.message });
  }
});

// API: Deletes custom boards
app.delete("/api/boards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await executeDbQuery(async (db) => {
      return await db.collection(collectionName).deleteOne({ id });
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Board not found" });
    }

    res.json({ success: true, id });
  } catch (err: any) {
    console.error("Failed to delete board:", err);
    res.status(500).json({ error: "Failed to delete board", details: err?.message });
  }
});

// Serve frontend assets via Vite in development, static files in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Admin Service] Running locally on http://localhost:${PORT}`);
  });
}

startServer();
