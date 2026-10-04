# Don't Say the Same Word as Me (Netlify version)

Host login, player accounts, and a public join link. It runs entirely on Netlify:
a static page, one Netlify Function for the API, and Netlify Blobs for storage.

## Deploy

1. Push this folder to a GitHub repository.
2. In Netlify choose Add new site, then Import an existing project, and pick the repository.
   Leave the build settings as they are (netlify.toml sets them).
3. Before the first deploy, open Site configuration, then Environment variables, and add:
   * `ADMIN_USERNAME`   your host username, for example `host`
   * `ADMIN_PASSWORD`   a strong host password (required)
   * `SESSION_SECRET`   optional, a long random string. If you skip it, one is derived from
     the host password.
4. Deploy. Your site address is the join link. Players open it and create an account.
   You open the same address, choose Host, and log in.

Command line instead:

    npm install -g netlify-cli
    netlify login
    netlify init
    netlify env:set ADMIN_USERNAME host
    netlify env:set ADMIN_PASSWORD "your-strong-password"
    netlify deploy --build --prod

Dragging a folder into Netlify's drop zone is not recommended, because the function needs
to be built with its dependency.

## How it works

* Players and the host get a signed cookie when they log in. Passwords are hashed with scrypt.
  The host password lives only in the environment variable.
* Pages check the game every 1.5 to 2.5 seconds. Nobody receives another player's word
  before the reveal.
* Netlify has no background process, so the timer is enforced whenever someone's page checks
  in after the deadline. The first check after time runs out reveals the words. If everyone
  has closed the page, the reveal waits until someone opens it again.
* Accounts and scores live in Netlify Blobs, so they survive redeploys.

## Limits

* One game at a time per site.
* Every page check is a function request. A room of 20 players generates tens of thousands
  of requests per hour, so check your Netlify plan's function usage before a big session.
* Login attempts are slowed down but not strictly rate limited.
* There is no password reset. The host can remove a player, who can then sign up again.
