FROM orbit-shared-browser:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xfce4 xfce4-terminal mousepad dbus-x11 xdotool scrot xclip x11-utils && rm -rf /var/lib/apt/lists/*
COPY start.py /opt/desktop-start.py
RUN chmod 644 /opt/desktop-start.py
USER browser
ENV HOME=/home/browser DISPLAY=:99
CMD ["python3", "/opt/desktop-start.py"]
