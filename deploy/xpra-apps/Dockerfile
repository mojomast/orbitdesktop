FROM orbit-xpra:pilot
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox thunar fonts-liberation libgtk2.0-0 libglu1-mesa libxinerama1 libxslt1.1 libnss3 libnspr4 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/office-install
RUN curl -fSLO https://downloads.apache.org/openoffice/4.1.16/binaries/en-US/Apache_OpenOffice_4.1.16_Linux_x86-64_install-deb_en-US.tar.gz && curl -fSLO https://downloads.apache.org/openoffice/4.1.16/binaries/en-US/Apache_OpenOffice_4.1.16_Linux_x86-64_install-deb_en-US.tar.gz.sha256 && sha256sum -c *.sha256 && tar xzf *.tar.gz && dpkg -i en-US/DEBS/*.deb && rm -rf /tmp/office-install
COPY start.py launch.py customize.py /opt/orbit-apps/
COPY orbit-fit.js /usr/share/xpra/www/orbit-fit.js
RUN chmod 755 /opt/orbit-apps && chmod 644 /opt/orbit-apps/*.py /usr/share/xpra/www/orbit-fit.js && python3 /opt/orbit-apps/customize.py
WORKDIR /home/browser
USER browser
CMD ["python3", "/opt/orbit-apps/start.py"]
