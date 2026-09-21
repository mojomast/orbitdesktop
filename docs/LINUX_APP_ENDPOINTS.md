# Portable Linux app endpoints (plugin 0.2.1)

Desktop Xpra launchers use the Orbit page's scheme and hostname with ports 4350–4356. Shared Chromium uses the same scheme/hostname on port 4344. Local Orbit at http://127.0.0.1:4318 therefore opens local HTTP services; HTTPS deployments open HTTPS services on their own hostname. No author-host fallback or automatic hostname discovery exists. IPv6 origins are supported. Apps must be explicitly provisioned; icons do not install them.

For local Xpra, build the base image from the extracted Orbit root:

```sh
docker build --build-arg ORBIT_ORIGIN=http://127.0.0.1:4318 -t orbit-xpra:pilot deploy/xpra
docker build -t orbit-xpra-apps:1 deploy/xpra-apps
```

For a remote deployment, replace ORBIT_ORIGIN with the exact HTTPS origin used to open Orbit, including its port. The build validates this origin and emits an exact frame-ancestors allowlist, not a wildcard. Rebuild the derived app image too. Configure TLS proxies for the app ports on that same hostname; HTTPS Orbit cannot embed plain HTTP apps. Tailscale is optional: after completing the password and image provisioning in XPRA_APPS.md, `python3 scripts/xpra_apps.py --tailscale` explicitly requests Tailscale Serve. Without that flag, the script publishes Docker ports on loopback only. Existing containers are never replaced by this script.

Shared Chromium still needs its separate deployment and authenticated password file. Password copying remains authenticated and copy-only. Do not put passwords in origins, URLs or build arguments. Do not expose raw X11, VNC or CDP ports publicly.

Historical verification documents describe prior deployments, not setup defaults. Existing saved browser panes retain their saved URLs; update those deliberately through workspace controls if migrating hosts. This release does not rewrite workspace data or restart apps, and cannot preserve unsaved app state across container replacement.
