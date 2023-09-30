https://hub.docker.com/r/redis/redis-stack

docker run -d --name redis-stack -p 9911:6379 -p 8001:8001 redis/redis-stack:7.2.0-v2
