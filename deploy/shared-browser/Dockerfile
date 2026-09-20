FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify openbox socat python3 ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 browser
COPY start.py /opt/start.py
RUN chmod 644 /opt/start.py
USER browser
ENV HOME=/home/browser DISPLAY=:99
CMD ["python3","/opt/start.py"]
