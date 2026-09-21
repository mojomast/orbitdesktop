FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg && curl -fsSL https://xpra.org/gpg.asc | gpg --dearmor -o /usr/share/keyrings/xpra.gpg
RUN printf 'deb [signed-by=/usr/share/keyrings/xpra.gpg] https://xpra.org bookworm main\n' > /etc/apt/sources.list.d/xpra.list && apt-get update && apt-get install -y --no-install-recommends xpra xpra-x11 xpra-server xpra-html5 xterm mousepad python3-tk xdotool x11-utils dbus-x11 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 browser
COPY start.py /opt/start.py
ARG ORBIT_ORIGIN=http://127.0.0.1:4318
COPY configure_csp.py /opt/configure_csp.py
RUN ORBIT_ORIGIN="$ORBIT_ORIGIN" python3 /opt/configure_csp.py
RUN chmod 644 /opt/start.py /etc/xpra/http-headers/10_content_security_policy.txt
RUN apt-get update && apt-get install -y --no-install-recommends xauth libx264-164 && rm -rf /var/lib/apt/lists/*
USER browser
ENV HOME=/home/browser DISPLAY=:100
EXPOSE 14500
CMD ["python3", "/opt/start.py"]
