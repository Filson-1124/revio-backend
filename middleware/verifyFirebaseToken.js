import { auth } from '../utils/firebaseAdmin.js';

const verifyFirebaseToken = async (req, res, next) => {

// This is included when disabling the Firebase authentication for testing purposes.
// start here.
  if (process.env.DISABLE_AUTH === "true") {
    req.user = { uid: "test-user" };
    return next();
  }
  // ends here.

  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed token' });
  }

  const idToken = header.split('Bearer ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.user = decodedToken; // attach decoded user info to request
    next();
  } catch (err) {
    console.error('Token verification failed:', err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export default verifyFirebaseToken;
