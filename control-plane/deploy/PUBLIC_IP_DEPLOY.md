# Direct public-IP deployment

This profile exposes only Nginx on ports 80/443. The Node controller stays on `127.0.0.1:8787`.

## Required pieces

- A public IPv4 or IPv6 address on the VPS.
- A TLS certificate valid for the address used by the phone.
- Nginx and systemd.
- Firewall rules allowing 80/443 and the chosen SSH port only.

## Steps

1. Copy `nginx-public-ip.conf` to the Nginx sites directory.
2. Replace `<PUBLIC_IP>` and certificate paths.
3. Set `PUBLIC_ORIGIN=https://<PUBLIC_IP>` in `/etc/openclaw-delegation.env`.
4. Install `openclaw-delegation.service` and set `DATA_DIR=/var/lib/openclaw-delegation`.
5. Test Nginx config, reload it, then enable the controller service.
6. Open `https://<PUBLIC_IP>` from the phone.

Never expose port 8787 publicly. Do not disable TLS verification on the phone; use a certificate the phone trusts.
