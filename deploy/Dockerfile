FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY deploy/server .
COPY deploy/libonnxruntime.so ./lib/
COPY deploy/dx7_codebook.bin deploy/dx7_codebook_timbre.bin ./
COPY index.html .
COPY html/ html/
COPY legal/ legal/

RUN chmod +x server && mkdir -p exports

EXPOSE 8080

ENTRYPOINT ["./server"]
CMD ["-port", "8080", "-generations", "20", "-population", "64"]
