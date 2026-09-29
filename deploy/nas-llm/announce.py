#!/usr/bin/env python3
"""nas-llm announcer — advertises the NAS LLM endpoint over DNS-SD so belt's
dynamic discovery layer can find it (_klh-llm._tcp). Runs in a host-network
container next to the LLM container. Multicast needs host networking."""
import socket
import time

from zeroconf import ServiceInfo, Zeroconf

zc = Zeroconf()
ip = socket.gethostbyname(socket.gethostname())
info = ServiceInfo(
	"_klh-llm._tcp.local.",
	"nas-llm._klh-llm._tcp.local.",
	addresses=[socket.inet_aton(ip)],
	port=11434,
	properties={"proto": "openai", "roles": "general,research"},
	server="nas-threads-dk.local.",
)
zc.register_service(info, ttl=120)
print("advertising nas-llm._klh-llm._tcp.local. ->", ip, ":11434", flush=True)
while True:
	time.sleep(60)
