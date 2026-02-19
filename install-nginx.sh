#!/bin/bash
sudo cp /etc/nginx/conf.d/croncoin.conf /etc/nginx/conf.d/croncoin.conf.bak
sudo cp /home/iamckj/croncoin-dashboard/croncoin-nginx.conf /etc/nginx/conf.d/croncoin.conf
sudo nginx -t && sudo nginx -s reload
echo "Done!"
