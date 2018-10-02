import cookieParser from "cookie-parser";
import express from "express";
import cookieSession from "cookie-session";
import nextApp from "next";
import request from "request";
import { useStaticRendering } from "mobx-react";
import logger from "lib/logger";
import passport from "passport";
import OAuth2Strategy from "passport-oauth2";
import refresh from "passport-oauth2-refresh";
import { appPath, dev } from "./config";
import router from "./routes";

const app = nextApp({ dir: appPath, dev });
const routeHandler = router.getRequestHandler(app);
const decodeOpaqueId = (opaqueId) => {
  if (opaqueId === undefined || opaqueId === null) return null;
  const unencoded = Buffer.from(opaqueId, "base64").toString("utf8");
  const [namespace, id] = unencoded.split(":");
  return { namespace, id };
};

// This is needed to allow custom parameters (e.g loginActions) to be included
// when requesting authorization. This is setup to allow only loginAction to pass through
OAuth2Strategy.prototype.authorizationParams = function (options = {}) {
  return { loginAction: options.loginAction };
};

useStaticRendering(true);

passport.use("oauth2", new OAuth2Strategy({
  authorizationURL: process.env.OAUTH2_AUTH_URL,
  tokenURL: process.env.OAUTH2_TOKEN_URL,
  clientID: process.env.OAUTH2_CLIENT_ID,
  clientSecret: process.env.OAUTH2_CLIENT_SECRET,
  callbackURL: process.env.OAUTH2_REDIRECT_URL,
  state: true,
  scope: ["offline", "openid"]
}, (accessToken, refreshToken, profile, cb) => {
  cb(null, { accessToken, profile });
}));

passport.use("refresh", refresh);

// The value passed to `done` here is stored on the session.
// We save the full user object in the session.
passport.serializeUser((user, done) => {
  done(null, JSON.stringify(user));
});

// The value returned from `serializeUser` is passed in from the session here,
// to get the user. We save the full user object in the session.
passport.deserializeUser((user, done) => {
  done(null, JSON.parse(user));
});

app
  .prepare()
  .then(() => {
    const server = express();

    const { SESSION_SECRET, SESSION_MAX_AGE_MS } = process.env;
    const maxAge = SESSION_MAX_AGE_MS ? Number(SESSION_MAX_AGE_MS) : 24 * 60 * 60 * 1000; // 24 hours

    // We use a client-side cookie session instead of a server session so that there are no
    // issues when load balancing without sticky sessions.
    // https://www.npmjs.com/package/cookie-session
    server.use(cookieSession({
      // https://www.npmjs.com/package/cookie-session#options
      keys: [SESSION_SECRET],
      maxAge,
      name: "storefront-session"
    }));

    // http://www.passportjs.org/docs/configure/
    server.use(passport.initialize());
    server.use(passport.session());
    server.use(cookieParser());

    server.get("/signin", (req, res, next) => {
      req.session.redirectTo = req.get("Referer");
      next(); // eslint-disable-line promise/no-callback-in-promise
    }, passport.authenticate("oauth2", { loginAction: "signin" }));

    server.get("/signup", (req, res, next) => {
      req.session.redirectTo = req.get("Referer");
      next(); // eslint-disable-line promise/no-callback-in-promise
    }, passport.authenticate("oauth2", { loginAction: "signup" }));

    // This endpoint handles OAuth2 requests (exchanges code for token)
    server.get("/callback", passport.authenticate("oauth2"), (req, res) => {
      // After success, redirect to the page we came from originally
      res.redirect(req.session.redirectTo || "/");
    });

    server.get("/logout/:userId", (req, res) => {
      const { id } = decodeOpaqueId(req.params.userId);
      request(`${process.env.OAUTH2_IDP_HOST_URL}logout?userId=${id}`, (error) => {
        if (!error) {
          req.logout();
          res.redirect(req.get("Referer") || "/");
        }
      });
    });

    // Setup next routes
    server.use(routeHandler);

    return server.listen(4000, (err) => {
      if (err) throw err;
      logger.appStarted("localhost", 4000);
    });
  })
  .catch((ex) => {
    logger.error(ex.stack);
    process.exit(1);
  });

export default app;
